/**
 * The store-path cancel seam (`cancelStoredRunAndDrain`) — three properties
 * the cancel-existing gate and the REST route depend on:
 *
 *   1. A victim LIVE IN THIS PROCESS is actually aborted. The seam flipped
 *      the row and drained, and the comment claimed a live controller "sees
 *      a lost lease at its next event write" — but the append fence only
 *      guards `running` rows, so the victim kept executing and writing to
 *      its cancelled row until the 40s renew tick noticed. The new run
 *      started while the old one's agents were still alive.
 *
 *   2. Cancel-existing does NOT drain. In a group mixing policies, each
 *      pass's drain started the next parked `queue` fire, which the next
 *      pass cancelled — queued work destroyed one fire per pass. The new
 *      run drains at its own terminal instead.
 *
 *   3. The flip is FENCED on the status just read. `resume()` claims its row
 *      with a CAS; an unfenced flip could land on a row that moved between
 *      the read and the write — stamping `cancelled` over a `done`, and
 *      draining a queue the terminal had already drained.
 *
 * On (1): the wait is bounded (LOCAL_UNWIND_BOUND_MS) and OBSERVABLE here.
 * A victim that unwinds in ~15ms — well inside the winner's HTTP round-trip
 * — would stay green with the whole wait loop deleted, pinning only the
 * abort half. So the victim takes a wedged-tool tail after the abort, which
 * makes "the winner started after the victim left the active map" a real
 * ordering the assertions can see; and a victim that never unwinds pins the
 * bound itself — proceed, loudly, after it.
 *
 * And the victim gets ONE `run-cancelled`. The aborted executor's unwind
 * yields its own sentinel, which the controller persists (the append fence
 * guards `running` rows only); the seam appended a second on top.
 */

import { promises as fs } from 'node:fs';
import {
  isActive,
  startRun as startServerRun,
} from '../src/server/run-controller';
import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  sleep,
  waitFor,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(60_000);

const GROUP = 'shared-device';
const CANCELLER = 'cancel-existing-orch';
const QUEUED = 'queued-orch';

async function startCanceller(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/runs/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orchestrationName: CANCELLER }),
    signal: AbortSignal.timeout(20_000),
  });
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string | null };
  expect(id).toBeTruthy();
  return id!;
}

describe('cancelStoredRunAndDrain', () => {
  let restoreEnv: () => void;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    const tmpRoot = await makeWorkspace('cancel-stored-paths');
    await writeOrchestration(tmpRoot, {
      name: CANCELLER,
      concurrency: { group: GROUP, policy: 'cancel-existing' },
      phases: [{ name: 'p', code: { source: "return 'won'" } }],
    });
    // A queued sibling whose only phase PAUSES at a lock, so a drained fire
    // visibly holds the group instead of finishing in a millisecond.
    await writeOrchestration(tmpRoot, {
      name: QUEUED,
      concurrency: { group: GROUP, policy: 'queue' },
      phases: [{ name: 'p', code: { source: "return 'q'" }, lock: true }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'drainable-orch',
      phases: [{ name: 'p', code: { source: "return 'drained'" } }],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    await fs.rm(mount.tmpRoot, { recursive: true, force: true });
    restoreEnv?.();
  });

  const runsOf = async (orch: string) =>
    (await mount.store.listRuns(100)).filter(r => r.orchestrationName === orch);

  async function seedPausedHolder(id: string, group: string): Promise<void> {
    await mount.store.upsertRun({
      id,
      orchestrationName: 'holder-orch',
      startedAt: Date.now() - 1_000,
      status: 'running',
      events: [],
      concurrencyGroup: group,
    });
    await mount.store.updateRunStatus(id, { status: 'paused', pausedFor: 'review-gate' });
  }

  /** The seam's bound (LOCAL_UNWIND_BOUND_MS in sammy-pack-api.ts). */
  const UNWIND_BOUND_MS = 5_000;
  /** How long the live victim takes to unwind after its abort — a tool
   *  call mid-flight. Long enough to dwarf the winner's HTTP round-trip. */
  const UNWIND_TAIL_MS = 300;

  it('(1) cancel-existing aborts a victim live in THIS process and waits for it to unwind', async () => {
    // A live holder of the group, driven by an event source that keeps
    // emitting until its signal fires, then takes a while to unwind and
    // yields its own `run-cancelled` — the real executor's shape for an
    // agent phase mid-flight (a RunCancelled caught after the tool returns).
    let victimSignal: AbortSignal | null = null;
    let unwoundAt = 0;
    const { id: victimId } = await startServerRun({
      store: mount.store,
      orchestrationName: 'live-victim',
      concurrencyGroup: GROUP,
      buildEventSource: signal => {
        victimSignal = signal;
        return (async function* () {
          while (!signal.aborted) {
            yield { type: 'tick', ts: Date.now() };
            await sleep(15);
          }
          await sleep(UNWIND_TAIL_MS);
          yield { type: 'run-cancelled', ts: Date.now() };
          unwoundAt = Date.now();
        })();
      },
    });
    await waitFor(
      async () =>
        ((await mount.store.getRun(victimId))?.events.some(e => e.type === 'tick') ? true : null),
      'victim is ticking',
    );

    // Captured before the spy is restored (restoring clears the calls).
    const warn = jest.spyOn(console, 'warn');
    const t0 = Date.now();
    let winnerId: string;
    let warned: string[];
    try {
      winnerId = await startCanceller(mount.baseUrl);
    } finally {
      warned = warn.mock.calls.map(c => String(c[0]));
      warn.mockRestore();
    }
    const elapsed = Date.now() - t0;

    // Pre-fix: the row was cancelled but nothing aborted the controller —
    // the signal stayed un-fired, isActive stayed true, and ticks kept
    // landing on the cancelled row.
    expect(victimSignal!.aborted).toBe(true);
    // The WAIT: the start did not respond until the victim had left the
    // active map, which it could only do after its tail. Without the wait
    // loop the response lands in ~100ms with the victim still executing.
    expect(elapsed).toBeGreaterThanOrEqual(UNWIND_TAIL_MS - 50);
    expect(isActive(victimId)).toBe(false);
    expect(unwoundAt).toBeGreaterThan(0);
    expect(warned.some(l => l.includes('had not unwound'))).toBe(false);
    const victim = await mount.store.getRun(victimId);
    expect(victim!.status).toBe('cancelled');
    // ONE sentinel: the executor's own. The seam used to append a second.
    expect(victim!.events.filter(e => e.type === 'run-cancelled')).toHaveLength(1);
    const ticks = () =>
      mount.store.getRun(victimId).then(r => r!.events.filter(e => e.type === 'tick').length);
    const settled = await ticks();
    await sleep(150);
    expect(await ticks()).toBe(settled);

    const winner = await waitFor(
      async () => {
        const r = await mount.store.getRun(winnerId);
        return r && r.status !== 'running' ? r : null;
      },
      'winner terminal',
    );
    expect(winner.status).toBe('done');
    // And the winner was created only after the victim unwound.
    expect(winner.startedAt).toBeGreaterThanOrEqual(unwoundAt);
  });

  it('(1b) a victim that never unwinds is waited for up to the bound, then proceeded past — loudly', async () => {
    // The wedged-tool case the bound exists for: the executor never reaches
    // its next await, so the abort is never observed and the controller
    // never leaves the active map.
    let releaseVictim!: () => void;
    const parked = new Promise<void>(resolve => {
      releaseVictim = resolve;
    });
    const { id: victimId } = await startServerRun({
      store: mount.store,
      orchestrationName: 'wedged-victim',
      concurrencyGroup: GROUP,
      buildEventSource: signal => {
        return (async function* () {
          while (!signal.aborted) {
            yield { type: 'tick', ts: Date.now() };
            await sleep(15);
          }
          await parked;
          yield { type: 'run-cancelled', ts: Date.now() };
        })();
      },
    });
    await waitFor(
      async () =>
        ((await mount.store.getRun(victimId))?.events.some(e => e.type === 'tick') ? true : null),
      'wedged victim is ticking',
    );

    // Captured before the spy is restored (restoring clears the calls).
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const t0 = Date.now();
    let winnerId: string;
    let warned: string[];
    try {
      winnerId = await startCanceller(mount.baseUrl);
    } finally {
      warned = warn.mock.calls.map(c => String(c[0]));
      warn.mockRestore();
    }
    const elapsed = Date.now() - t0;
    try {
      // Bounded: waited the full bound, not forever and not for no time.
      expect(elapsed).toBeGreaterThanOrEqual(UNWIND_BOUND_MS - 100);
      expect(elapsed).toBeLessThan(UNWIND_BOUND_MS * 3);
      // Loud: the lapse is on the log, naming the run and the bound.
      expect(
        warned.some(
          l =>
            l.includes(victimId) &&
            l.includes(`had not unwound within ${UNWIND_BOUND_MS}ms`),
        ),
      ).toBe(true);
      // Fail-open, documented: the row is cancelled (its next fenced write
      // stops it), the victim is still in the active map, the winner ran.
      expect(isActive(victimId)).toBe(true);
      expect((await mount.store.getRun(victimId))!.status).toBe('cancelled');
      const winner = await waitFor(
        async () => {
          const r = await mount.store.getRun(winnerId);
          return r && r.status !== 'running' ? r : null;
        },
        'winner terminal past a wedged victim',
      );
      expect(winner.status).toBe('done');
    } finally {
      // Let the wedged executor unwind so nothing lingers into the next case.
      releaseVictim();
      await waitFor(async () => (isActive(victimId) ? null : true), 'wedged victim unwound');
    }
  });

  it('(2) cancel-existing cancels WITHOUT draining; the new run drains at its own terminal', async () => {
    await waitFor(
      async () => ((await mount.store.findActiveRunsInGroup(GROUP)).length === 0 ? true : null),
      'group idle',
    );
    await seedPausedHolder('holder-mixed', GROUP);
    for (const n of [1, 2]) {
      await mount.store.enqueuePendingFire(GROUP, {
        orchName: QUEUED,
        initialInput: `parked-${n}`,
        ownerId: 'system',
      });
    }

    const winnerId = await startCanceller(mount.baseUrl);
    expect((await mount.store.getRun('holder-mixed'))!.status).toBe('cancelled');
    await waitFor(
      async () => ((await mount.store.getRunSummary(winnerId))?.status === 'done' ? true : null),
      'winner done',
    );
    // The winner's terminal drained ONE parked fire, which now holds the
    // group at its lock; the other is still parked. Pre-fix each pass's
    // drain hatched a queued fire only for the next pass to cancel it:
    // both parked fires ended `cancelled` and the queue was empty.
    const hatched = await waitFor(
      async () => (await runsOf(QUEUED)).find(r => r.status === 'paused') ?? null,
      'one queued fire hatched by the winner\'s terminal',
    );
    expect(hatched.initialInput).toBe('parked-1');
    expect((await runsOf(QUEUED)).filter(r => r.status === 'cancelled')).toHaveLength(0);
    expect(await mount.store.countPendingFires(GROUP)).toBe(1);
  });

  it('(3) a row that moved between the read and the write is not stamped over', async () => {
    await seedPausedHolder('holder-moved', 'g-moved');
    await mount.store.enqueuePendingFire('g-moved', {
      orchName: 'drainable-orch',
      initialInput: null,
      ownerId: 'system',
    });
    // Between the seam's read of `paused` and its write, the run finishes
    // (a peer's terminal, a gate approved and completed) — simulated by
    // flipping the row inside the read, so the seam holds a stale status.
    const real = mount.store.getRun.bind(mount.store);
    const spy = jest.spyOn(mount.store, 'getRun');
    spy.mockImplementation(async (id, owner) => {
      const row = await real(id, owner);
      if (id === 'holder-moved' && row?.status === 'paused') {
        spy.mockRestore();
        await mount.store.updateRunStatus(
          'holder-moved',
          { status: 'done', endedAt: Date.now() },
          { onlyIfStatus: ['paused'] },
        );
      }
      return row;
    });
    const res = await fetch(`${mount.baseUrl}/api/runs/holder-moved/cancel`, { method: 'POST' });
    spy.mockRestore();
    expect(res.status).toBe(200);
    // Pre-fix: the unfenced flip stamped `cancelled` over `done`, appended a
    // sentinel to a finished run, and drained the queue a second time.
    expect(await res.json()).toMatchObject({ ok: false, status: 'done' });
    const row = await mount.store.getRun('holder-moved');
    expect(row!.status).toBe('done');
    expect(row!.events.filter(e => e.type === 'run-cancelled')).toHaveLength(0);
    expect(await mount.store.countPendingFires('g-moved')).toBe(1);
  });

  it('(3b) a resume that lands in the gap is cancelled on re-read, not left running', async () => {
    await seedPausedHolder('holder-resumed', 'g-resumed');
    const real = mount.store.getRun.bind(mount.store);
    const spy = jest.spyOn(mount.store, 'getRun');
    spy.mockImplementation(async (id, owner) => {
      const row = await real(id, owner);
      if (id === 'holder-resumed' && row?.status === 'paused') {
        spy.mockRestore();
        // resume()'s own claim: paused → running, CAS on paused.
        await mount.store.updateRunStatus(
          'holder-resumed',
          { status: 'running', pausedFor: null, endedAt: null },
          { onlyIfStatus: ['paused'] },
        );
      }
      return row;
    });
    const res = await fetch(`${mount.baseUrl}/api/runs/holder-resumed/cancel`, { method: 'POST' });
    spy.mockRestore();
    expect(await res.json()).toMatchObject({ ok: true, cancelled: true });
    expect((await mount.store.getRun('holder-resumed'))!.status).toBe('cancelled');
  });
});
