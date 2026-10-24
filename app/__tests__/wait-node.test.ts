/**
 * Tests for the `wait` body kind — durable timers + external signals.
 *
 * Executor-level semantics (server pause path AND the in-memory fallback):
 *   - a relative timer completes in-process when no durable pause is
 *     available, with the structured `{"waited":…,"kind":"timer",…}` output
 *   - an already-past `until` completes immediately with `waited: false`
 *   - an unparseable `until` is a normal phase failure
 *   - signal waits consume buffered deliveries FIFO (payload = output)
 *   - an in-memory signal wait with nothing buffered fails LOUDLY (no
 *     silent forever-hang) with a message pointing at the server path
 *   - a timed-out signal wait is a retryable phase error → onError works
 *   - `durableWaits: true` parks: `wait-started` (with the fixed absolute
 *     deadline) then RunPauseRequested carrying the same spec
 *   - a resumed leg honors the ORIGINAL deadline via `pendingWaits` (never
 *     re-arms the clock) and replays a completed wait via `replayOutputs`
 */

import {
  runOrchestration,
  RunPauseRequested,
  type PendingWaitSpec,
  type RunEvent,
  type StreamFn,
} from '../src/llm/executor';
import type { Node } from '../src/types';

/** Wait/code-only orchestrations must never reach an LLM. */
const explodingStreamFn: StreamFn = async function* () {
  throw new Error('streamFn must not be called for wait/code leaves');
};

async function collect(
  orchestration: Node,
  opts: Partial<Parameters<typeof runOrchestration>[0]> = {},
): Promise<{ events: RunEvent[]; thrown: unknown }> {
  const events: RunEvent[] = [];
  let thrown: unknown = null;
  try {
    for await (const ev of runOrchestration({
      orchestration,
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      streamFn: explodingStreamFn,
      waitForApproval: async () => true,
      cancelled: { v: false },
      agentsOverride: [],
      orchestrationsOverride: [],
      ...opts,
    })) {
      events.push(ev);
    }
  } catch (err) {
    thrown = err;
  }
  return { events, thrown };
}

const phaseEnd = (events: RunEvent[], name: string) =>
  events.find(e => e.type === 'phase-end' && e.phaseName === name) as
    | Extract<RunEvent, { type: 'phase-end' }>
    | undefined;

describe('wait — in-memory timers', () => {
  test('seconds: 0.1 sleeps in-process and completes with waited:true (zero cost)', async () => {
    const { events, thrown } = await collect({
      name: 'flow',
      phases: [{ name: 'cool-down', wait: { seconds: 0.1 } }],
    });
    expect(thrown).toBeNull();
    const started = events.find(e => e.type === 'wait-started');
    expect(started).toMatchObject({ kind: 'timer', durable: false });
    const end = phaseEnd(events, 'cool-down');
    expect(end).toBeDefined();
    expect(end!.costUsd).toBe(0);
    expect(JSON.parse(end!.output)).toMatchObject({ waited: true, kind: 'timer' });
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });

  test('until in the past completes IMMEDIATELY with waited:false (no wait-started)', async () => {
    const { events, thrown } = await collect({
      name: 'flow',
      phases: [
        { name: 'no-op-wait', wait: { until: '2020-01-01T00:00:00Z' } },
      ],
    });
    expect(thrown).toBeNull();
    expect(events.some(e => e.type === 'wait-started')).toBe(false);
    const end = phaseEnd(events, 'no-op-wait');
    expect(JSON.parse(end!.output)).toMatchObject({ waited: false, kind: 'timer' });
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });

  test('unparseable until is a normal phase failure', async () => {
    const { events } = await collect({
      name: 'flow',
      phases: [{ name: 'bad-wait', wait: { until: 'not-a-date' } }],
    });
    expect(
      events.some(
        e =>
          e.type === 'phase-error' &&
          e.phaseName === 'bad-wait' &&
          /ISO-8601/.test(e.error),
      ),
    ).toBe(true);
    expect(events.some(e => e.type === 'run-end')).toBe(false);
  });
});

describe('wait — signals (in-memory buffering semantics)', () => {
  test('buffered payloads are consumed FIFO across waits on the same name', async () => {
    const { events, thrown } = await collect(
      {
        name: 'flow',
        phases: [
          { name: 'first', wait: { signal: 'go' } },
          { name: 'second', wait: { signal: 'go' } },
        ],
      },
      { deliveredSignals: { go: ['payload-1', 'payload-2'] } },
    );
    expect(thrown).toBeNull();
    expect(phaseEnd(events, 'first')!.output).toBe('payload-1');
    expect(phaseEnd(events, 'second')!.output).toBe('payload-2');
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });

  test('signal name interpolates against state', async () => {
    const { events, thrown } = await collect(
      {
        name: 'flow',
        vars: { channel: 'deploy-done' },
        phases: [{ name: 'gate', wait: { signal: '${channel}' } }],
      },
      { deliveredSignals: { 'deploy-done': ['shipped'] } },
    );
    expect(thrown).toBeNull();
    expect(phaseEnd(events, 'gate')!.output).toBe('shipped');
  });

  test('nothing buffered + no durable pause = LOUD failure naming the server path', async () => {
    const { events } = await collect({
      name: 'flow',
      phases: [{ name: 'gate', wait: { signal: 'never-comes' } }],
    });
    expect(
      events.some(
        e =>
          e.type === 'phase-error' &&
          /server-owned run/.test(e.error) &&
          /signal/.test(e.error),
      ),
    ).toBe(true);
    expect(events.some(e => e.type === 'run-end')).toBe(false);
  });

  test('an expired signal deadline is a retryable phase error — onError recovers', async () => {
    const expired: PendingWaitSpec = {
      replayKey: 'gate',
      kind: 'signal',
      signal: 'go',
      deadline: Date.now() - 1_000,
    };
    const { events, thrown } = await collect(
      {
        name: 'flow',
        phases: [
          {
            name: 'gate',
            wait: { signal: 'go', timeoutSeconds: 1 },
            onError: {
              name: 'gate/fallback',
              code: { source: "return 'recovered-without-signal'" },
            },
          },
        ],
      },
      { pendingWaits: { gate: expired } },
    );
    expect(thrown).toBeNull();
    expect(
      events.some(
        e => e.type === 'phase-error' && /timed out/.test(e.error),
      ),
    ).toBe(true);
    expect(phaseEnd(events, 'gate/fallback')!.output).toBe(
      'recovered-without-signal',
    );
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });
});

describe('wait — durable pause path (server-owned)', () => {
  test('an unelapsed timer emits wait-started then throws RunPauseRequested with the SAME spec', async () => {
    const before = Date.now();
    const { events, thrown } = await collect(
      {
        name: 'flow',
        phases: [{ name: 'cool-down', wait: { seconds: 3600 } }],
      },
      { durableWaits: true },
    );
    expect(thrown).toBeInstanceOf(RunPauseRequested);
    const pause = thrown as RunPauseRequested;
    expect(pause.pausedFor).toBe('cool-down');
    expect(pause.wait).toMatchObject({ replayKey: 'cool-down', kind: 'timer' });
    // Absolute deadline fixed at first crossing, ~1h out.
    expect(pause.wait!.resumeAt!).toBeGreaterThanOrEqual(before + 3_599_000);
    const started = events.find(e => e.type === 'wait-started');
    expect(started).toMatchObject({
      kind: 'timer',
      durable: true,
      replayKey: 'cool-down',
    });
    if (started?.type === 'wait-started') {
      expect(started.resumeAt).toBe(pause.wait!.resumeAt);
    }
  });

  test('a signal wait with no delivery parks durably carrying name + deadline', async () => {
    const { thrown } = await collect(
      {
        name: 'flow',
        phases: [
          { name: 'gate', wait: { signal: 'approve', timeoutSeconds: 60 } },
        ],
      },
      { durableWaits: true },
    );
    expect(thrown).toBeInstanceOf(RunPauseRequested);
    const pause = thrown as RunPauseRequested;
    expect(pause.wait).toMatchObject({ kind: 'signal', signal: 'approve' });
    expect(typeof pause.wait!.deadline).toBe('number');
  });
});

describe('wait — resume honors the original deadline', () => {
  test('a seeded pendingWait whose resumeAt has passed completes without re-arming', async () => {
    const original: PendingWaitSpec = {
      replayKey: 'cool-down',
      kind: 'timer',
      resumeAt: Date.now() - 5_000, // came due while the run was parked
    };
    const startedAt = Date.now();
    const { events, thrown } = await collect(
      {
        name: 'flow',
        // A re-arm bug would turn this into a fresh 1h wait on every resume.
        phases: [{ name: 'cool-down', wait: { seconds: 3600 } }],
      },
      { durableWaits: true, pendingWaits: { 'cool-down': original } },
    );
    expect(thrown).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const end = phaseEnd(events, 'cool-down');
    expect(JSON.parse(end!.output)).toMatchObject({ waited: true, kind: 'timer' });
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });

  test('a seeded pendingWait that is still not due re-parks with the ORIGINAL resumeAt', async () => {
    const original: PendingWaitSpec = {
      replayKey: 'cool-down',
      kind: 'timer',
      resumeAt: Date.now() + 60_000,
    };
    const { thrown } = await collect(
      {
        name: 'flow',
        phases: [{ name: 'cool-down', wait: { seconds: 3600 } }],
      },
      { durableWaits: true, pendingWaits: { 'cool-down': original } },
    );
    expect(thrown).toBeInstanceOf(RunPauseRequested);
    expect((thrown as RunPauseRequested).wait!.resumeAt).toBe(original.resumeAt);
  });

  test('a completed wait replays from replayOutputs (no wait-started, no sleep)', async () => {
    const { events, thrown } = await collect(
      {
        name: 'flow',
        phases: [{ name: 'cool-down', wait: { seconds: 3600 } }],
      },
      {
        durableWaits: true,
        replayOutputs: {
          'cool-down': '{"waited":true,"kind":"timer","resumeAt":"x"}',
        },
      },
    );
    expect(thrown).toBeNull();
    expect(events.some(e => e.type === 'wait-started')).toBe(false);
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });
});
