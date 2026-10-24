/**
 * Tests for server/wait-resolution.ts — the pure event-stream derivation
 * behind durable waits, and the sweeper core.
 *
 *   - deriveWaitState: unresolved wait-started specs become pendingWaits; a
 *     phase-end (or leafOutputs checkpoint) with the same replayKey resolves
 *     them; signal-received payloads buffer FIFO minus the deliveries
 *     already consumed by COMPLETED signal-waits (a timed-out / failed wait
 *     consumes nothing).
 *   - sweepDueWaits: header-only decisions (timer due / signal deadline),
 *     plus the once-per-pause-leg buffered-signal event scan, deduped via
 *     the caller's checkedSignalScans set.
 */

import {
  deriveWaitState,
  pendingWaitOf,
  sweepDueWaits,
} from '../src/server/wait-resolution';
import type { RunHeader, Run, StoredEvent } from '../src/server/run-store';

const ws = (
  replayKey: string,
  kind: 'timer' | 'signal',
  extra: Record<string, unknown> = {},
): StoredEvent => ({ type: 'wait-started', phaseName: replayKey, replayKey, kind, durable: true, ts: 1, ...extra });

const pe = (replayKey: string): StoredEvent => ({
  type: 'phase-end',
  phaseName: replayKey,
  replayKey,
  output: 'x',
  ts: 2,
});

const sr = (signal: string, payload: string): StoredEvent => ({
  type: 'signal-received',
  signal,
  payload,
  ts: 3,
});

describe('deriveWaitState', () => {
  test('an unresolved wait-started is pending; a phase-end resolves it', () => {
    const pending = deriveWaitState([ws('a', 'timer', { resumeAt: 99 })], {});
    expect(pending.pendingWaits).toEqual({
      a: { replayKey: 'a', kind: 'timer', resumeAt: 99 },
    });

    const resolved = deriveWaitState(
      [ws('a', 'timer', { resumeAt: 99 }), pe('a')],
      {},
    );
    expect(resolved.pendingWaits).toEqual({});
  });

  test('a leafOutputs checkpoint also counts as resolved', () => {
    const seed = deriveWaitState([ws('a', 'timer', { resumeAt: 99 })], {
      a: '{"waited":true}',
    });
    expect(seed.pendingWaits).toEqual({});
  });

  test('keepalive re-emissions of the same wait collapse to one pending spec', () => {
    const seed = deriveWaitState(
      [ws('a', 'timer', { resumeAt: 99 }), ws('a', 'timer', { resumeAt: 99 })],
      {},
    );
    expect(Object.keys(seed.pendingWaits)).toEqual(['a']);
  });

  test('signal buffering: completed signal-waits consume FIFO; failed ones consume nothing', () => {
    // Two deliveries of "go"; one COMPLETED wait on "go" → one payload left.
    const seed = deriveWaitState(
      [
        sr('go', 'p1'),
        ws('w1', 'signal', { signal: 'go' }),
        pe('w1'),
        sr('go', 'p2'),
        ws('w2', 'signal', { signal: 'go' }),
        // w2 never completed (timed out / still parked) → consumes nothing.
      ],
      {},
    );
    expect(seed.deliveredSignals).toEqual({ go: ['p2'] });
    expect(Object.keys(seed.pendingWaits)).toEqual(['w2']);
  });

  test('fully consumed names are omitted from deliveredSignals', () => {
    const seed = deriveWaitState(
      [sr('go', 'p1'), ws('w1', 'signal', { signal: 'go' }), pe('w1')],
      {},
    );
    expect(seed.deliveredSignals).toEqual({});
  });
});

describe('pendingWaitOf', () => {
  test('reads a valid spec off stateJson and rejects malformed ones', () => {
    expect(
      pendingWaitOf({ pendingWait: { replayKey: 'a', kind: 'timer', resumeAt: 5 } }),
    ).toEqual({ replayKey: 'a', kind: 'timer', resumeAt: 5 });
    expect(pendingWaitOf(null)).toBeNull();
    expect(pendingWaitOf({})).toBeNull();
    expect(pendingWaitOf({ pendingWait: { kind: 'nope' } })).toBeNull();
    expect(pendingWaitOf({ pendingWait: { kind: 'timer' } })).toBeNull();
  });
});

describe('sweepDueWaits', () => {
  const header = (
    id: string,
    status: RunHeader['status'],
    pendingWait: unknown,
  ): RunHeader =>
    ({
      id,
      orchestrationName: 'flow',
      startedAt: 0,
      endedAt: null,
      status,
      orchestrationSnapshot: null,
      initialInput: null,
      currentPath: null,
      stateJson: pendingWait ? { pendingWait } : {},
      lastOutput: null,
      pausedFor: 'w',
      completedLeaves: [],
      updatedAt: 0,
      ownerId: 'system',
      concurrencyGroup: null,
      degraded: false,
      degradationReasons: [],
    }) as RunHeader;

  function fakeStore(headers: RunHeader[], eventsById: Record<string, StoredEvent[]> = {}) {
    const getRunCalls: string[] = [];
    return {
      getRunCalls,
      // The sweeper's view: unbounded paused-run listing. The fake passes
      // mixed statuses through to exercise the defensive status guard.
      listPausedRuns: async () => headers,
      getRun: async (id: string): Promise<Run | null> => {
        getRunCalls.push(id);
        const h = headers.find(x => x.id === id);
        if (!h) return null;
        return { ...h, events: eventsById[id] ?? [], eventVersion: 1 };
      },
    };
  }

  test('due timers resume; undue ones and non-paused runs do not', async () => {
    const now = 1_000_000;
    const store = fakeStore([
      header('due', 'paused', { replayKey: 'w', kind: 'timer', resumeAt: now - 1 }),
      header('not-due', 'paused', { replayKey: 'w', kind: 'timer', resumeAt: now + 1 }),
      header('running', 'running', { replayKey: 'w', kind: 'timer', resumeAt: now - 1 }),
      header('no-wait', 'paused', null),
    ]);
    const resumed: Array<[string, string]> = [];
    await sweepDueWaits(store, {
      now,
      resume: async (id, reason) => void resumed.push([id, reason]),
    });
    expect(resumed).toEqual([['due', 'timer-due']]);
  });

  test('signal deadline resumes (to surface the timeout error)', async () => {
    const now = 1_000_000;
    const store = fakeStore([
      header('expired', 'paused', {
        replayKey: 'w',
        kind: 'signal',
        signal: 'go',
        deadline: now - 1,
      }),
    ]);
    const resumed: string[] = [];
    await sweepDueWaits(store, {
      now,
      resume: async (_id, reason) => void resumed.push(reason),
    });
    expect(resumed).toEqual(['signal-deadline']);
  });

  test('buffered-before-pause signal is found by the one-time event scan (deduped across sweeps)', async () => {
    const now = 1_000_000;
    const pw = { replayKey: 'w', kind: 'signal', signal: 'go' };
    const store = fakeStore([header('r1', 'paused', pw)], {
      r1: [ws('w', 'signal', { signal: 'go' }), sr('go', 'early-bird')],
    });
    const resumed: string[] = [];
    const checked = new Set<string>();
    await sweepDueWaits(store, {
      now,
      checkedSignalScans: checked,
      resume: async (_id, reason) => void resumed.push(reason),
    });
    expect(resumed).toEqual(['signal-buffered']);
    expect(store.getRunCalls).toEqual(['r1']);

    // Second sweep: same pause leg → no re-scan, no duplicate resume.
    await sweepDueWaits(store, {
      now,
      checkedSignalScans: checked,
      resume: async (_id, reason) => void resumed.push(reason),
    });
    expect(resumed).toEqual(['signal-buffered']);
    expect(store.getRunCalls).toEqual(['r1']);
  });

  test('a run with NO buffered delivery just stays parked', async () => {
    const store = fakeStore(
      [header('r1', 'paused', { replayKey: 'w', kind: 'signal', signal: 'go' })],
      { r1: [ws('w', 'signal', { signal: 'go' })] },
    );
    const resumed: string[] = [];
    await sweepDueWaits(store, {
      resume: async (_id, reason) => void resumed.push(reason),
    });
    expect(resumed).toEqual([]);
  });

  test('a throwing resume is isolated — the sweep continues to later runs', async () => {
    const now = 1_000_000;
    const store = fakeStore([
      header('boom', 'paused', { replayKey: 'w', kind: 'timer', resumeAt: now - 1 }),
      header('fine', 'paused', { replayKey: 'w', kind: 'timer', resumeAt: now - 1 }),
    ]);
    const resumed: string[] = [];
    await sweepDueWaits(store, {
      now,
      resume: async (id) => {
        if (id === 'boom') throw new Error('resume exploded');
        resumed.push(id);
      },
    });
    expect(resumed).toEqual(['fine']);
  });
});
