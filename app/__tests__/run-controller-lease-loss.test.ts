/**
 * Lease loss and resume races in the run-controller.
 *
 * Two defects share one mechanism — a write that reads as legitimate to the
 * store but is stale to the run's real owner:
 *
 *   - A leg whose lease a PEER reclaimed used to unwind through the ordinary
 *     abort path and write a terminal (`cancelled`, or `done` for a source
 *     that simply stops on the signal) over the reclaim's `interrupted`. The
 *     checkpoint survived; the run was permanently unresumable.
 *   - Two concurrent `resume()` calls both passed a read-then-write status
 *     guard and both started an executor for one run id.
 *
 * Both are staged against the real SQLite store. The lease-loss case drives
 * the renew tick with fake timers (the cadence is derived from the lease TTL,
 * far too long to wait for), keeping setImmediate real so the controller's
 * own microtask + store traffic still flows.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteRunStore } from '../src/server/db';
import { DurableGroupLock } from '../src/server/concurrency-group';
import * as reap from '../src/server/reap';
import { DEFAULT_LEASE_TTL_MS } from '../src/server/run-store';
import {
  _resetForTests as _resetController,
  isActive,
  resume,
  startRun,
} from '../src/server/run-controller';

let tmpRoot: string;
let store: SqliteRunStore;

beforeEach(async () => {
  _resetController();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-rc-lease-'));
  store = new SqliteRunStore(tmpRoot, { instanceId: 'this-process' });
  await store.init();
});

afterEach(async () => {
  _resetController();
  jest.useRealTimers();
  await store.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** Poll on real setImmediate (never faked here) until `cond` holds. */
async function until(cond: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 2_000; i++) {
    if (await cond()) return;
    await new Promise(r => setImmediate(r));
  }
  throw new Error(`timeout waiting for ${what}`);
}

const waitForFinish = (id: string) =>
  until(async () => !isActive(id), `run ${id} to finish`);

describe('lease lost on the renew tick', () => {
  it("yields WITHOUT a terminal: the reclaim's `interrupted` + checkpoint survive, no sentinel is appended", async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });

    async function* source(
      signal: AbortSignal,
    ): AsyncIterable<Record<string, unknown> & { type: string }> {
      yield { type: 'run-start', orchestrationName: 'x', ts: 0 };
      yield { type: 'phase-start', phaseName: 'a', agentPath: 'code', ts: 1 };
      yield { type: 'phase-end', phaseName: 'a', replayKey: 'a', output: 'A', ts: 2 };
      yield { type: 'phase-start', phaseName: 'b', agentPath: 'code', ts: 3 };
      // Park like a long silent model call until the controller aborts us,
      // then unwind the way the real executor does: the in-flight leaf
      // reports its failure and the root yields the `run-cancelled`
      // sentinel. appendEvent's fence allows writes to a non-running row, so
      // without the controller refusing to persist past the loss these
      // landed AFTER the reclaim's `run-interrupted` — a resumable row that
      // read `…, run-interrupted, phase-error, run-cancelled`.
      await new Promise<void>(r => {
        if (signal.aborted) r();
        else signal.addEventListener('abort', () => r(), { once: true });
      });
      yield { type: 'phase-error', phaseName: 'b', error: 'run cancelled', ts: 4 };
      yield { type: 'run-cancelled', ts: 5 };
    }

    const { id } = await startRun({
      store,
      orchestrationName: 'x',
      buildEventSource: signal => source(signal),
    });
    await until(
      async () => (await store.getRun(id))?.completedLeaves?.length === 1,
      'the checkpoint to land',
    );

    // A PEER reclaims the run out from under us: our lease "expired" (the
    // scan runs past the TTL), the row is `interrupted`, the lease cleared.
    const peer = new SqliteRunStore(tmpRoot, { instanceId: 'peer' });
    await peer.init();
    try {
      const reclaimed = await peer.markOrphanedRunsAsInterrupted(
        Date.now() + 10 * 60_000,
      );
      expect(reclaimed.ids).toContain(id);
    } finally {
      await peer.close();
    }
    expect((await store.getRun(id))?.status).toBe('interrupted');

    // The renew tick fires; the store reports the lease gone; the controller
    // aborts the leg and must unwind WITHOUT writing.
    jest.advanceTimersByTime(DEFAULT_LEASE_TTL_MS);
    await waitForFinish(id);

    const run = await store.getRun(id);
    expect(run?.status).toBe('interrupted'); // never 'cancelled' / 'done'
    expect(run?.completedLeaves).toEqual(['a']); // checkpoint intact
    const types = run?.events.map(e => e.type) ?? [];
    // The reclaim's marker is the LAST word: nothing from the de-leased
    // leg's unwind — not the leaf's phase-error, not the run-cancelled
    // sentinel — lands after it.
    expect(types[types.length - 1]).toBe('run-interrupted');
    expect(types.filter(t => t === 'run-end' || t === 'run-cancelled' || t === 'run-error')).toEqual([]);
    expect(types).not.toContain('phase-error');

    // Resumable — the whole point. (The lease is claimed by the resumer.)
    const resumed = await resume({
      store,
      id,
      buildEventSource: () =>
        (async function* () {
          yield { type: 'phase-end', phaseName: 'b', replayKey: 'b', output: 'B', ts: 3 };
        })(),
    });
    expect(resumed.ok).toBe(true);
    await waitForFinish(id);
    expect((await store.getRun(id))?.status).toBe('done');
  });

  it('schedules the same descendant reap cancel() does — a wedged tool never unwinds to the terminal reap', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const reapSpy = jest
      .spyOn(reap, 'reapNewDescendants')
      .mockResolvedValue({ killed: [] });
    try {
      // A leaf wedged on a hung tool: ignores the abort signal entirely, so
      // the controller's loop never reaches its terminal reap. The abort only
      // reaches the SDK's direct subprocess; whatever that agent spawned via a
      // Bash tool would leak for good.
      async function* wedged(): AsyncIterable<Record<string, unknown> & { type: string }> {
        yield { type: 'run-start', orchestrationName: 'x', ts: 0 };
        yield { type: 'phase-start', phaseName: 'a', agentPath: 'code', ts: 1 };
        yield { type: 'phase-end', phaseName: 'a', replayKey: 'a', output: 'A', ts: 2 };
        await new Promise<void>(() => {});
      }
      const { id } = await startRun({
        store,
        orchestrationName: 'x',
        buildEventSource: () => wedged(),
      });
      await until(
        async () => (await store.getRun(id))?.completedLeaves?.length === 1,
        'the checkpoint to land',
      );
      const peer = new SqliteRunStore(tmpRoot, { instanceId: 'peer' });
      await peer.init();
      try {
        expect(
          (await peer.markOrphanedRunsAsInterrupted(Date.now() + 10 * 60_000)).ids,
        ).toContain(id);
      } finally {
        await peer.close();
      }

      // The renew tick notices the loss and aborts; the wedged leg stays
      // active (nothing unwinds), so the only reap that can run is the one
      // scheduled off the abort — the same 1.5s grace cancel() gives the SDK.
      jest.advanceTimersByTime(DEFAULT_LEASE_TTL_MS);
      for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
      expect(isActive(id)).toBe(true);
      expect(reapSpy).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1_500);
      for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
      expect(reapSpy).toHaveBeenCalledTimes(1);
      // Scoped to this run: it never reaps another live run's processes.
      expect(reapSpy).toHaveBeenCalledWith(process.pid, expect.any(Set), {
        graceMs: 3000,
        runId: expect.any(String),
        otherRunsActive: expect.any(Boolean),
      });
    } finally {
      reapSpy.mockRestore();
    }
  });
});

describe('resume() of a group-released run takes the group lock', () => {
  /** A source that parks until `release` resolves, so the winner is still
   *  HOLDING the group while the loser decides. */
  function parkedUntil(release: Promise<void>) {
    return () =>
      (async function* () {
        await release;
        yield { type: 'phase-end', phaseName: 'p', replayKey: 'p', output: 'o', ts: 1 };
      })();
  }

  const interruptedInGroup = async (id: string, group: string): Promise<void> => {
    await store.upsertRun({
      id,
      orchestrationName: 'x',
      startedAt: 1,
      status: 'running',
      events: [{ type: 'run-start', ts: 0 }],
      concurrencyGroup: group,
    });
    await store.updateRunStatus(id, { status: 'interrupted', endedAt: 2 });
  };

  it('two interrupted runs of one `queue` group resumed together: exactly one runs, the other is refused as busy', async () => {
    // An error/interrupted terminal RELEASED the group, so neither row holds
    // a slot: a plain group read saw "empty" for both, both claimed their own
    // row (different ids, so the per-row CAS could not arbitrate), and both
    // executed against the resource the group serialises.
    await interruptedInGroup('g1', 'grp');
    await interruptedInGroup('g2', 'grp');
    let release!: () => void;
    const held = new Promise<void>(r => {
      release = r;
    });
    const results = await Promise.all([
      resume({ store, id: 'g1', buildEventSource: parkedUntil(held) }),
      resume({ store, id: 'g2', buildEventSource: parkedUntil(held) }),
    ]);
    expect(results.filter(r => r.ok).length).toBe(1);
    const loser = results.find(r => !r.ok);
    expect(loser && 'reason' in loser ? loser.reason : '').toMatch(
      /Concurrency group "grp" is busy/,
    );
    // Exactly one holder while the winner runs.
    expect((await store.findActiveRunsInGroup('grp')).length).toBe(1);
    release();
    await waitForFinish('g1');
    await waitForFinish('g2');
    const statuses = [
      (await store.getRun('g1'))?.status,
      (await store.getRun('g2'))?.status,
    ].sort();
    expect(statuses).toEqual(['done', 'interrupted']);
  });

  it('a resume racing a fresh START in the same group: one holder (the lock is the one the start-gate takes)', async () => {
    await interruptedInGroup('g1', 'grp');
    // The start-gate's shape: decide under the group's store-backed lock,
    // then create. Hold its critical section open across the resume so the
    // resume's group read can only be correct if it waits for the lock.
    const gate = new DurableGroupLock(store, { holder: 'gate' });
    let enterGate!: () => void;
    const gateEntered = new Promise<void>(r => {
      enterGate = r;
    });
    let releaseGate!: () => void;
    const gateHeld = new Promise<void>(r => {
      releaseGate = r;
    });
    const never = new Promise<void>(() => {});
    const started = gate.run('grp', async () => {
      expect(await store.findActiveRunsInGroup('grp')).toEqual([]);
      enterGate();
      await gateHeld;
      return startRun({
        store,
        orchestrationName: 'x',
        concurrencyGroup: 'grp',
        buildEventSource: parkedUntil(never),
      });
    });
    await gateEntered;
    const resumed = resume({ store, id: 'g1', buildEventSource: parkedUntil(never) });
    // Without the lock the resume reads the (still empty) group right here
    // and claims; with it, it is parked behind the gate's section.
    await new Promise(r => setTimeout(r, 150));
    releaseGate();
    const [start, res] = await Promise.all([started, resumed]);
    expect(res.ok).toBe(false);
    expect('reason' in res ? res.reason : '').toMatch(/busy \(run run-/);
    const active = await store.findActiveRunsInGroup('grp');
    expect(active.map(r => r.id)).toEqual([start.id]);
    expect((await store.getRun('g1'))?.status).toBe('interrupted');
  });
});

describe('fenced writes after a reclaim (no renew tick involved)', () => {
  /** Stage: a run checkpoints leaf `a`, then a PEER reclaims it while the
   *  leg is still "working". `onReclaimed` releases the source afterwards. */
  async function reclaimedMidLeg(
    tail: (signal: AbortSignal) => AsyncIterable<Record<string, unknown> & { type: string }>,
  ): Promise<string> {
    let release!: () => void;
    const reclaimDone = new Promise<void>(r => {
      release = r;
    });
    async function* source(signal: AbortSignal) {
      yield { type: 'run-start', orchestrationName: 'x', ts: 0 };
      yield { type: 'phase-start', phaseName: 'a', agentPath: 'code', ts: 1 };
      yield { type: 'phase-end', phaseName: 'a', replayKey: 'a', output: 'A', ts: 2 };
      await reclaimDone;
      yield* tail(signal);
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'x',
      buildEventSource: signal => source(signal),
    });
    await until(
      async () => (await store.getRun(id))?.completedLeaves?.length === 1,
      'the checkpoint to land',
    );
    const peer = new SqliteRunStore(tmpRoot, { instanceId: 'peer' });
    await peer.init();
    try {
      expect(
        (await peer.markOrphanedRunsAsInterrupted(Date.now() + 10 * 60_000)).ids,
      ).toContain(id);
    } finally {
      await peer.close();
    }
    release();
    await waitForFinish(id);
    return id;
  }

  it('a fenced CHECKPOINT stops the leg — the LeaseLostError is rethrown, not swallowed (L-3)', async () => {
    // The de-leased leg's next phase-end event itself still lands (the event
    // fence is scoped to running rows), but its checkpoint — the wholesale
    // overwrite of completed_leaves — must be refused, and that refusal must
    // END the leg rather than be logged and carried past: phase `c` is work
    // the peer is now doing.
    const id = await reclaimedMidLeg(async function* () {
      yield { type: 'phase-start', phaseName: 'b', agentPath: 'code', ts: 3 };
      yield { type: 'phase-end', phaseName: 'b', replayKey: 'b', output: 'B', ts: 4 };
      yield { type: 'phase-start', phaseName: 'c', agentPath: 'code', ts: 5 }; // never
    });
    const run = await store.getRun(id);
    expect(run?.status).toBe('interrupted');
    expect(run?.completedLeaves).toEqual(['a']);
    expect(run?.stateJson).toEqual({ leafOutputs: { a: 'A' } });
    const started = run?.events.filter(e => e.type === 'phase-start').map(e => e.phaseName);
    expect(started).not.toContain('c');
  });

  it('a fenced TERMINAL: a leg that finishes before the next renew tick does not stamp its status', async () => {
    // The renew handler only samples the lease every LEASE_RENEW_MS; a leg
    // reclaimed and finished inside that window reaches the terminal block
    // with the lease silently gone. Its `done` must not land on the row.
    const id = await reclaimedMidLeg(async function* () {
      /* clean finish → the controller's own terminal would read 'done' */
    });
    const run = await store.getRun(id);
    expect(run?.status).toBe('interrupted');
    expect(run?.completedLeaves).toEqual(['a']);
  });
});

describe('resume() claims, not check-then-act', () => {
  it('two concurrent resume() calls: exactly one wins, one run-resumed event, one executor', async () => {
    await store.upsertRun({
      id: 'r',
      orchestrationName: 'x',
      startedAt: 1,
      status: 'running',
      events: [{ type: 'run-start', ts: 0 }],
    });
    await store.updateRunStatus('r', { status: 'paused', pausedFor: 'gate' });

    let built = 0;
    const buildEventSource = () => {
      built += 1;
      return (async function* () {
        yield { type: 'phase-end', phaseName: 'p', replayKey: 'p', output: 'o', ts: 1 };
      })();
    };
    // Both read the row as `paused` before either flips it — the race the
    // status guard alone cannot close.
    const results = await Promise.all([
      resume({ store, id: 'r', buildEventSource }),
      resume({ store, id: 'r', buildEventSource }),
    ]);
    expect(results.filter(r => r.ok).length).toBe(1);
    const loser = results.find(r => !r.ok);
    expect(loser && 'reason' in loser ? loser.reason : '').toMatch(/another caller/);

    await waitForFinish('r');
    const run = await store.getRun('r');
    expect(run?.status).toBe('done');
    expect(run?.events.filter(e => e.type === 'run-resumed').length).toBe(1);
    expect(built).toBe(1);
  });
});
