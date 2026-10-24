/**
 * The cancel-existing start-gate must not re-enter its own group lock.
 *
 * `startRunWithConcurrency` serializes its check-and-create under
 * `groupLock.run(group)`. The cancel-existing branch used to await
 * `cancelStoredRunAndDrain` INSIDE that section. That cancel releases the
 * victim's group and drains the next parked fire — `fireRun` →
 * `startRunWithConcurrency` → `groupLock.run(SAME group)` — and the lock is
 * a non-reentrant promise chain: the drain waited on the section that was
 * waiting on the drain. The start never responded and every later fire for
 * the group chained behind it for the life of the process.
 *
 * The existing cancel-drain tests park `drainable-orch`, which has NO
 * concurrency block, so the drained fire never touched the lock and the
 * hang was invisible to them. This case parks an orchestration with a REAL
 * concurrency block on the same group — the policy's ordinary steady state
 * (an active run plus a parked fire) — and bounds the start with a client
 * timeout so a regression fails in seconds rather than hanging the suite.
 *
 * The second half pins the belt-and-braces: `GroupLock` itself refuses to
 * wait forever. A hang is strictly worse than an error — the error names
 * the group, lands in the log, and lets the gate's fail-open path run.
 */

import { GroupLock } from '../src/server/concurrency-group';
import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  waitFor,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(60_000);

const GROUP = 'shared-env';
const CANCELLER = 'cancel-existing-orch';
const PARKED = 'parked-orch';

/** POST /api/runs/start with a client-side deadline. Pre-fix the request
 *  never completed; a bounded fetch turns that into a crisp failure. */
async function startBounded(
  baseUrl: string,
  orchestrationName: string,
  deadlineMs: number,
): Promise<{ id: string | null; concurrency?: string }> {
  const res = await fetch(`${baseUrl}/api/runs/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orchestrationName }),
    signal: AbortSignal.timeout(deadlineMs),
  });
  return (await res.json()) as { id: string | null; concurrency?: string };
}

describe('cancel-existing start-gate does not deadlock on its own group', () => {
  let restoreEnv: () => void;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    const tmpRoot = await makeWorkspace('cancel-existing-reentry');
    await writeOrchestration(tmpRoot, {
      name: CANCELLER,
      concurrency: { group: GROUP, policy: 'cancel-existing' },
      phases: [{ name: 'p', code: { source: "return 'won'" } }],
    });
    // The parked fire carries its OWN concurrency block on the same group,
    // so draining it re-enters the gate for that group — the hang shape.
    await writeOrchestration(tmpRoot, {
      name: PARKED,
      concurrency: { group: GROUP, policy: 'queue' },
      phases: [{ name: 'p', code: { source: "return 'drained'" } }],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  it('responds, cancels the holder, drains the parked fire, and leaves the group usable', async () => {
    // A paused holder: counts as active (holds the group) and has no live
    // controller, so the cancel takes the store path that drains.
    await mount.store.upsertRun({
      id: 'holder-ce',
      orchestrationName: 'holder-orch',
      startedAt: Date.now() - 1_000,
      status: 'running',
      events: [],
      concurrencyGroup: GROUP,
    });
    await mount.store.updateRunStatus('holder-ce', {
      status: 'paused',
      pausedFor: 'review-gate',
    });
    await mount.store.enqueuePendingFire(GROUP, {
      orchName: PARKED,
      initialInput: null,
      ownerId: 'system',
    });

    const started = await startBounded(mount.baseUrl, CANCELLER, 15_000);
    expect(started.id).toBeTruthy();

    const holder = await mount.store.getRun('holder-ce');
    expect(holder!.status).toBe('cancelled');

    // The holder's cancel released the group and the parked fire became a
    // real run (whatever it then did under the newest fire's policy).
    await waitFor(
      async () =>
        (await mount.store.listRuns(50)).find(r => r.orchestrationName === PARKED) ??
        null,
      'parked fire drained into a run',
    );
    const winner = await waitFor(
      async () => {
        const r = await mount.store.getRun(started.id!);
        return r && r.status !== 'running' && r.status !== 'paused' ? r : null;
      },
      'winner reaches a terminal status',
    );
    expect(winner.status).toBe('done');
    expect(await mount.store.countPendingFires(GROUP)).toBe(0);

    // THE GROUP IS STILL USABLE: pre-fix the very next fire for this group
    // chained behind the stuck section forever.
    const again = await startBounded(mount.baseUrl, CANCELLER, 15_000);
    expect(again.id).toBeTruthy();
    const second = await waitFor(
      async () => {
        const r = await mount.store.getRun(again.id!);
        return r && r.status !== 'running' && r.status !== 'paused' ? r : null;
      },
      'second fire reaches a terminal status',
    );
    expect(second.status).toBe('done');
  });
});

describe('GroupLock acquisition timeout', () => {
  it('rejects, naming the group, instead of waiting forever behind a stuck holder', async () => {
    const lock = new GroupLock({ acquireTimeoutMs: 200 });
    let releaseHolder!: () => void;
    const holder = lock.run(
      'stuck-group',
      () =>
        new Promise<void>(resolve => {
          releaseHolder = resolve;
        }),
    );

    const waiter = lock.run('stuck-group', async () => 'ran');
    const outcome = await Promise.race([
      waiter.then(
        () => 'resolved',
        (e: Error) => `rejected: ${e.message}`,
      ),
      new Promise<string>(r => setTimeout(() => r('still waiting'), 2_000)),
    ]);
    expect(outcome).toMatch(
      /^rejected: group lock for "stuck-group" not acquired within 200ms/,
    );

    // Giving up must not break serialization: a later waiter still runs
    // only AFTER the real holder releases, never alongside it.
    const order: string[] = [];
    const third = lock.run('stuck-group', async () => {
      order.push('third');
    });
    await new Promise(r => setTimeout(r, 20));
    expect(order).toEqual([]);
    releaseHolder();
    await holder;
    await third;
    expect(order).toEqual(['third']);
  });

  it('a group that is NOT contended acquires immediately (the default timeout is inert)', async () => {
    const lock = new GroupLock();
    await expect(lock.run('free-group', async () => 42)).resolves.toBe(42);
  });

  it('drops a group\'s tail once it drains — uncontended and contended alike', async () => {
    // The cleanup compared the map entry against the wrong promise, so it
    // never matched and the map grew by one entry per distinct group for
    // the life of the process.
    const lock = new GroupLock();
    await lock.run('g-once', async () => {});
    expect(lock._tailCountForTests()).toBe(0);

    // The gate is created up front: the lock invokes its section only after
    // an (async) acquisition, so a resolver captured inside it is not yet
    // assigned when the contender is queued.
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const first = lock.run('g-twice', () => gate);
    const second = lock.run('g-twice', async () => 'second');
    expect(lock._tailCountForTests()).toBe(1);
    releaseFirst();
    await first;
    await expect(second).resolves.toBe('second');
    expect(lock._tailCountForTests()).toBe(0);
  });
});
