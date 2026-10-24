/**
 * Composite resilience — four ways a composite survives trouble:
 *   - graceful composite timeout (finalize-with-partials)
 *   - the finalizer phase (`finally: true`)
 *   - code.run stderr / stdout-tail capture
 *   - the notify-on-terminal webhook (the notify.ts seam)
 *
 * The executor tests mock the LLM at the module level (no network), the same
 * pattern as executor.test.ts: a per-call `responder` for the default
 * (Anthropic) path, plus `providerStreamFns` to route a phase to a stream we
 * can drive on a clock (so we can make a branch HANG past a deadline).
 */

import {
  runOrchestration,
  type RunEvent,
  type StreamFn,
} from '../src/llm/executor';
import type { Node } from '../src/types';
import {
  buildTerminalNotifyPayload,
  fireTerminalNotify,
} from '../src/server/notify';

// ── Mock the default (Anthropic) stream, identical shape to executor.test.ts ──
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
                  usage: { inputTokens: 5, outputTokens: 7 },
                },
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
    { name: 'a', raw: '---\nname: a\n---\nAgent A. Input: ${input}' },
    { name: 'b', raw: '---\nname: b\n---\nAgent B.' },
    { name: 'slow', raw: '---\nname: slow\n---\nSlow agent.' },
    { name: 'collect', raw: '---\nname: collect\n---\nAggregator.' },
  ],
  listOrchestrations: async () => [],
}));

function setResponder(
  fn: (sys: string, user: string) => Promise<string> | string,
): void {
  mockState.responder = fn;
  mockState.callCount = 0;
}

async function runToCompletion(
  orchestration: Node,
  opts?: {
    initialInput?: string;
    providerStreamFns?: Record<string, StreamFn>;
    allowAgentTools?: boolean;
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
    allowAgentTools: opts?.allowAgentTools,
  })) {
    events.push(ev);
  }
  return events;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A provider stream that yields ONE progress delta (so the stall watchdog
 *  sees a heartbeat) and then HANGS forever — never reaching `done`. Used to
 *  simulate the still-in-flight branch when a composite deadline fires. The
 *  composite's deadline-drain abandons it (fire-and-forget `.return()`), so a
 *  permanent hang is fine for the COMPOSITE partial tests. */
const hangingStream: StreamFn = async function* () {
  yield { type: 'text-delta', text: 'working…' };
  await new Promise<void>(() => {
    /* never resolves */
  });
};

/** A provider stream that is SLOW (resolves after `ms`) but does eventually
 *  finish. Used where a LEAF must time out and then have its teardown complete
 *  (a leaf's withTimeout awaits the underlying stream's `.return()`, which only
 *  settles once the pending await resolves — a permanent hang would wedge it).
 */
function slowResolvingStream(ms: number): StreamFn {
  return async function* () {
    await sleep(ms);
    yield { type: 'text-delta', text: 'late' };
    yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Graceful composite timeout (finalize-with-partials)
// ──────────────────────────────────────────────────────────────────────────
describe('composite finalize-with-partials', () => {
  test('a timed-out parallel emits composite-partial + pipes the completed branch downstream', async () => {
    setResponder((_sys, user) => {
      // The aggregator (last phase) echoes what it received so we can assert
      // the partial reached it.
      return `agg:${user}`;
    });
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'fan',
            // 120ms composite deadline; the fast branch finishes well under it,
            // the openai-routed branch hangs forever.
            timeout: 0.12,
            parallel: [
              { name: 'fast', agent: 'agents/a.md' },
              { name: 'stuck', agent: 'agents/slow.md', provider: 'openai' },
            ],
          },
          { name: 'aggregate', agent: 'agents/collect.md' },
        ],
      },
      {
        initialInput: 'go',
        providerStreamFns: { openai: hangingStream },
        allowAgentTools: true,
      },
    );

    const partial = events.find(e => e.type === 'composite-partial');
    expect(partial).toBeDefined();
    if (partial?.type !== 'composite-partial')
      throw new Error('expected composite-partial');
    expect(partial.phaseName).toBe('fan');
    expect(partial.kind).toBe('parallel');
    expect(partial.completed).toBe(1); // only `fast` finished
    expect(partial.total).toBe(2);

    // The run did NOT error — the partial flows on as the composite's output.
    expect(events.some(e => e.type === 'run-error')).toBe(false);
    expect(events.some(e => e.type === 'run-end')).toBe(true);

    // The downstream aggregate phase ran and received the completed branch's
    // output (not nothing).
    const agg = events.find(
      e => e.type === 'phase-end' && e.phaseName === 'aggregate',
    );
    expect(agg).toBeDefined();
    if (agg?.type !== 'phase-end') throw new Error('expected aggregate end');
    expect(agg.output.startsWith('agg:')).toBe(true);
    // `fast` produced an empty-ish output via the default mock responder; the
    // key assertion is the aggregate RAN with the partial as input, which it
    // could only do because the composite finalized instead of discarding.
  }, 5000);

  test('a timed-out parallel still emits composite-end after the partial', async () => {
    setResponder(() => 'ok');
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'fan',
            timeout: 0.12,
            parallel: [
              { name: 'fast', agent: 'agents/a.md' },
              { name: 'stuck', agent: 'agents/slow.md', provider: 'openai' },
            ],
          },
        ],
      },
      {
        providerStreamFns: { openai: hangingStream },
        allowAgentTools: true,
      },
    );
    const partialIdx = events.findIndex(e => e.type === 'composite-partial');
    const endIdx = events.findIndex(
      e => e.type === 'composite-end' && e.phaseName === 'fan',
    );
    expect(partialIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(partialIdx);
  }, 5000);

  test('a map that times out finalizes with the completed items', async () => {
    setResponder(() => 'item-done');
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'sweep',
            timeout: 0.12,
            map: {
              over: '["x","y"]',
              // The body routes to the hanging stream so NEITHER item can
              // finish — but we still get a partial event (completed: 0) rather
              // than a hard error, proving the deadline path runs for `map`.
              body: { name: 'probe', agent: 'agents/slow.md', provider: 'openai' },
            },
          },
        ],
      },
      {
        providerStreamFns: { openai: hangingStream },
        allowAgentTools: true,
      },
    );
    const partial = events.find(e => e.type === 'composite-partial');
    expect(partial).toBeDefined();
    if (partial?.type !== 'composite-partial')
      throw new Error('expected composite-partial');
    expect(partial.kind).toBe('map');
    expect(partial.total).toBe(2);
    expect(events.some(e => e.type === 'run-error')).toBe(false);
  }, 5000);

  test('a parallel that finishes in time does NOT emit composite-partial (no regression)', async () => {
    setResponder(() => 'fine');
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        {
          name: 'fan',
          timeout: 5,
          parallel: [
            { name: 'b1', agent: 'agents/a.md' },
            { name: 'b2', agent: 'agents/b.md' },
          ],
        },
      ],
    });
    expect(events.some(e => e.type === 'composite-partial')).toBe(false);
    expect(events.some(e => e.type === 'composite-end')).toBe(true);
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Finalizer phase (`finally: true`)
// ──────────────────────────────────────────────────────────────────────────
describe('finalizer phase (finally: true)', () => {
  test('a finally phase runs after a normal phase THROWS, and the original error still bubbles', async () => {
    const ran: string[] = [];
    setResponder((sys) => {
      if (sys.includes('Aggregator')) {
        ran.push('finalizer');
        return 'cleaned up';
      }
      ran.push('boom');
      throw new Error('phase exploded');
    });
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        { name: 'work', agent: 'agents/a.md' },
        { name: 'triage', agent: 'agents/collect.md', finally: true },
      ],
    });
    // Finalizer ran even though `work` threw.
    expect(ran).toContain('finalizer');
    // The finalizer emitted its phase-end…
    expect(
      events.some(e => e.type === 'phase-end' && e.phaseName === 'triage'),
    ).toBe(true);
    // …but the ORIGINAL failure is what ends the run (the finalizer didn't mask it).
    const runErr = events.find(e => e.type === 'run-error');
    expect(runErr).toBeDefined();
    expect((runErr as { error?: string }).error).toMatch(/phase exploded/);
  });

  test('a finally phase runs after a prior phase TIMES OUT', async () => {
    const ran: string[] = [];
    setResponder((sys) => {
      if (sys.includes('Aggregator')) {
        ran.push('finalizer');
        return 'done';
      }
      return 'unused';
    });
    const events = await runToCompletion(
      {
        name: 'flow',
        phases: [
          {
            name: 'slow',
            agent: 'agents/slow.md',
            provider: 'openai',
            timeout: 0.05, // 50ms — the stream resolves only after 300ms
          },
          { name: 'triage', agent: 'agents/collect.md', finally: true },
        ],
      },
      {
        providerStreamFns: { openai: slowResolvingStream(300) },
        allowAgentTools: true,
      },
    );
    expect(ran).toContain('finalizer');
    expect(
      events.some(e => e.type === 'phase-end' && e.phaseName === 'triage'),
    ).toBe(true);
    // The timeout still surfaces as the run's terminal failure.
    expect(events.some(e => e.type === 'run-error')).toBe(true);
  }, 5000);

  test('a finally phase that ITSELF errors does not mask the original error', async () => {
    setResponder((sys) => {
      if (sys.includes('Aggregator')) throw new Error('finalizer also failed');
      throw new Error('ORIGINAL failure');
    });
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        { name: 'work', agent: 'agents/a.md' },
        { name: 'triage', agent: 'agents/collect.md', finally: true },
      ],
    });
    // Both failures surface as phase-errors…
    const phaseErrors = events.filter(e => e.type === 'phase-error');
    expect(
      phaseErrors.some(e => (e as { error?: string }).error?.includes('finalizer also failed')),
    ).toBe(true);
    // …but the run's terminal error is the ORIGINAL, not the finalizer's.
    const runErr = events.find(e => e.type === 'run-error');
    expect((runErr as { error?: string }).error).toMatch(/ORIGINAL failure/);
    expect((runErr as { error?: string }).error).not.toMatch(/finalizer also failed/);
  });

  test('a finally phase runs on the happy path too (after the regular phases)', async () => {
    const order: string[] = [];
    setResponder((sys) => {
      if (sys.includes('Aggregator')) {
        order.push('finalizer');
        return 'summary';
      }
      order.push('work');
      return 'work-out';
    });
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        { name: 'work', agent: 'agents/a.md' },
        { name: 'triage', agent: 'agents/collect.md', finally: true },
      ],
    });
    expect(order).toEqual(['work', 'finalizer']);
    expect(events.some(e => e.type === 'run-error')).toBe(false);
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });

  test('a finally phase works inside a NESTED phases composite too', async () => {
    const ran: string[] = [];
    setResponder((sys) => {
      if (sys.includes('Aggregator')) {
        ran.push('nested-finalizer');
        return 'nested cleanup';
      }
      ran.push('nested-work');
      throw new Error('nested boom');
    });
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        {
          name: 'group',
          phases: [
            { name: 'inner-work', agent: 'agents/a.md' },
            { name: 'inner-triage', agent: 'agents/collect.md', finally: true },
          ],
        },
      ],
    });
    expect(ran).toContain('nested-finalizer');
    expect(
      events.some(e => e.type === 'phase-end' && e.phaseName === 'inner-triage'),
    ).toBe(true);
    const runErr = events.find(e => e.type === 'run-error');
    expect((runErr as { error?: string }).error).toMatch(/nested boom/);
  });

  test('a continueOnError finalizer does not propagate its own failure', async () => {
    setResponder((sys) => {
      if (sys.includes('Aggregator')) throw new Error('cleanup hiccup');
      return 'work fine';
    });
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        { name: 'work', agent: 'agents/a.md' },
        {
          name: 'triage',
          agent: 'agents/collect.md',
          finally: true,
          continueOnError: true,
        },
      ],
    });
    // The regular phases succeeded and the finalizer's failure was swallowed
    // (continueOnError) → the run ends cleanly.
    expect(
      events.some(
        e =>
          e.type === 'phase-error' &&
          (e as { error?: string }).error?.includes('cleanup hiccup'),
      ),
    ).toBe(true);
    expect(events.some(e => e.type === 'run-error')).toBe(false);
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// code.run stderr / stdout-tail capture
// ──────────────────────────────────────────────────────────────────────────
describe('code.run surfaces stderr on a non-zero exit', () => {
  const prev = process.env.SAMMY_ALLOW_CODE_RUN;
  beforeAll(() => {
    process.env.SAMMY_ALLOW_CODE_RUN = '1';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.SAMMY_ALLOW_CODE_RUN;
    else process.env.SAMMY_ALLOW_CODE_RUN = prev;
  });

  test('the phase-error includes the script stderr, not just the exit code', async () => {
    setResponder(() => 'x');
    const events = await runToCompletion({
      name: 'root',
      phases: [
        { name: 'producer', agent: 'agents/a.md' },
        {
          name: 'boom',
          // Print a distinctive marker to stderr, then exit non-zero.
          code: { run: 'echo "DIAG-stderr-marker" 1>&2; exit 7' },
        },
      ],
    });
    const err = events.find(
      e => e.type === 'phase-error' && e.phaseName === 'boom',
    );
    expect(err).toBeDefined();
    const msg = (err as { error?: string }).error ?? '';
    expect(msg).toContain('exited with code 7');
    expect(msg).toContain('stderr');
    expect(msg).toContain('DIAG-stderr-marker');
  });

  test('when stderr is empty, the stdout tail is surfaced instead', async () => {
    setResponder(() => 'x');
    const events = await runToCompletion({
      name: 'root',
      phases: [
        { name: 'producer', agent: 'agents/a.md' },
        {
          name: 'boom',
          code: { run: 'echo "DIAG-stdout-marker"; exit 2' },
        },
      ],
    });
    const err = events.find(
      e => e.type === 'phase-error' && e.phaseName === 'boom',
    );
    const msg = (err as { error?: string }).error ?? '';
    expect(msg).toContain('exited with code 2');
    expect(msg).toContain('DIAG-stdout-marker');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Notify-on-terminal webhook (the notify.ts seam)
// ──────────────────────────────────────────────────────────────────────────
describe('notify-on-terminal', () => {
  test('buildTerminalNotifyPayload includes a bounded summary tail', () => {
    const longOutput = 'A'.repeat(5000);
    const payload = buildTerminalNotifyPayload({
      notify: { onTerminal: 'http://hook.test/x' },
      runId: 'run-1',
      orchestration: 'nightly-sweep',
      status: 'done',
      lastOutput: longOutput,
    });
    expect(payload.runId).toBe('run-1');
    expect(payload.orchestration).toBe('nightly-sweep');
    expect(payload.status).toBe('done');
    expect(payload.summary?.length).toBe(2000); // bounded tail
    expect(payload.summary?.endsWith('A')).toBe(true);
  });

  test('buildTerminalNotifyPayload omits summary when there is no output', () => {
    const payload = buildTerminalNotifyPayload({
      notify: { onTerminal: 'http://hook.test/x' },
      runId: 'run-2',
      orchestration: 'x',
      status: 'error',
      lastOutput: null,
    });
    expect('summary' in payload).toBe(false);
  });

  test('fireTerminalNotify POSTs the envelope to notify.onTerminal', async () => {
    const calls: Array<{ url: string; body: string; method: string }> = [];
    const spy = (
      url: string,
      init: { method: string; headers: Record<string, string>; body: string },
    ) => {
      calls.push({ url, body: init.body, method: init.method });
      return Promise.resolve({ ok: true });
    };
    const fired = fireTerminalNotify(
      {
        notify: { onTerminal: 'http://hook.test/terminal' },
        runId: 'run-99',
        orchestration: 'nightly-sweep',
        status: 'done',
        lastOutput: 'all green',
      },
      spy,
    );
    expect(fired).toBe(true);
    // Let the fire-and-forget microtask settle.
    await sleep(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://hook.test/terminal');
    expect(calls[0].method).toBe('POST');
    const sent = JSON.parse(calls[0].body);
    expect(sent).toEqual({
      runId: 'run-99',
      orchestration: 'nightly-sweep',
      status: 'done',
      summary: 'all green',
    });
  });

  test('fireTerminalNotify is a no-op when no onTerminal URL is configured', () => {
    const spy = jest.fn(() => Promise.resolve());
    expect(fireTerminalNotify({
      notify: undefined,
      runId: 'r',
      orchestration: 'o',
      status: 'done',
    }, spy as never)).toBe(false);
    expect(fireTerminalNotify({
      notify: { onTerminal: '' },
      runId: 'r',
      orchestration: 'o',
      status: 'done',
    }, spy as never)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  test('fireTerminalNotify swallows a rejected POST (best-effort, never throws)', async () => {
    const spy = () => Promise.reject(new Error('endpoint down'));
    // Must not throw despite the rejection.
    const fired = fireTerminalNotify(
      {
        notify: { onTerminal: 'http://hook.test/dead' },
        runId: 'run-x',
        orchestration: 'o',
        status: 'error',
      },
      spy,
    );
    expect(fired).toBe(true);
    await sleep(0); // give the swallowed rejection a tick
    // Reaching here without an unhandled rejection is the assertion.
  });

  test('fireTerminalNotify fires on a non-done terminal status (cancelled / paused)', async () => {
    const seen: string[] = [];
    const spy = (
      _url: string,
      init: { method: string; headers: Record<string, string>; body: string },
    ) => {
      seen.push(JSON.parse(init.body).status);
      return Promise.resolve();
    };
    fireTerminalNotify(
      { notify: { onTerminal: 'http://h/x' }, runId: 'r1', orchestration: 'o', status: 'cancelled' },
      spy,
    );
    fireTerminalNotify(
      { notify: { onTerminal: 'http://h/x' }, runId: 'r2', orchestration: 'o', status: 'paused' },
      spy,
    );
    await sleep(0);
    expect(seen).toEqual(['cancelled', 'paused']);
  });
});
