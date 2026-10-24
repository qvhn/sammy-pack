/**
 * LIFECYCLE CASE 3 — CANCEL × CONCURRENCY QUEUE.
 *
 * One orchestration with `concurrency: { group, policy: 'queue' }`. Run A
 * starts and HOLDS the group by snapshot-pausing at a lock (paused counts as
 * active). Two more starts of the same orchestration park as pending fires
 * (the API returns { id: null, concurrency: 'queued' } — accept ≠ execute).
 *
 * The chaos sequence the unit tests never covered end-to-end:
 *   cancel A  → the /cancel no-live-controller path must release the group
 *               AND drain exactly ONE parked fire (FIFO: B before C), which
 *               starts FOR REAL through the executor and pauses at ITS lock;
 *   cancel B' → drains the second fire (C');
 *   cancel C' → the bulk sequence is complete: the queue must be EMPTY, no
 *               new run may materialize afterwards, and the group must be
 *               fully released — no stranded fires, no zombie starts.
 *
 * Store-level observables (countPendingFires / findActiveRunsInGroup) are
 * read through the SAME store handle the mount runs on.
 */

import { promises as fs } from 'node:fs';
import {
  cancelRun,
  getRun,
  listRuns,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  sleep,
  startRun,
  waitFor,
  waitForRun,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(30_000);

const ORCH = 'lifecycle-queue';
const GROUP = 'lifecycle-chaos-group';

describe('lifecycle: cancel × concurrency queue (case 3)', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;

  let idA: string;
  let idB: string;
  let idC: string;

  /** The run (beyond `known` ids) that the drain started, identified by its
   *  initialInput — the pending fire carries it through fireRun. */
  async function findDrainedRun(
    input: string,
    known: string[],
  ): Promise<{ id: string; status: string }> {
    return waitFor(async () => {
      const runs = await listRuns(mount.baseUrl);
      const hit = runs.find(
        r =>
          r.orchestrationName === ORCH &&
          !known.includes(r.id) &&
          r.initialInput === input,
      );
      return hit ? { id: hit.id, status: hit.status } : null;
    }, `drained run with input ${input}`);
  }

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await makeWorkspace('queue');
    await writeOrchestration(tmpRoot, {
      name: ORCH,
      concurrency: { group: GROUP, policy: 'queue' },
      phases: [
        { name: 'mark', code: { source: "return 'mark:' + (input || 'none');" } },
        { name: 'hold', lock: true, code: { source: "return 'held';" } },
      ],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount.kill();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  it('run A starts, pauses at its lock, and HOLDS the group', async () => {
    const a = await startRun(mount.baseUrl, ORCH, 'A');
    expect(a.id).toBeTruthy();
    idA = a.id!;

    const paused = await waitForRun(mount.baseUrl, idA, ['paused']);
    expect(paused.pausedFor).toBe('hold');

    // Paused counts as ACTIVE — the group is held.
    const active = await mount.store.findActiveRunsInGroup(GROUP);
    expect(active.map(r => r.id)).toEqual([idA]);
  });

  it('two more starts QUEUE behind the holder (no run rows created)', async () => {
    const b = await startRun(mount.baseUrl, ORCH, 'B');
    expect(b).toEqual({ id: null, concurrency: 'queued' });
    const c = await startRun(mount.baseUrl, ORCH, 'C');
    expect(c).toEqual({ id: null, concurrency: 'queued' });

    expect(await mount.store.countPendingFires(GROUP)).toBe(2);
    // Still exactly one run row — the parked fires are durable rows, not runs.
    const runs = (await listRuns(mount.baseUrl)).filter(
      r => r.orchestrationName === ORCH,
    );
    expect(runs.map(r => r.id)).toEqual([idA]);
  });

  it('cancelling the paused holder drains exactly ONE fire (FIFO: B), which starts and pauses', async () => {
    const res = await cancelRun(mount.baseUrl, idA);
    // A paused run has no live controller — this is the direct-write path
    // that historically stranded the queue.
    expect(res).toMatchObject({ ok: true, cancelled: true });
    expect((await getRun(mount.baseUrl, idA)).status).toBe('cancelled');

    // FIFO: the fire enqueued FIRST (B) is the one drained.
    const drained = await findDrainedRun('B', [idA]);
    idB = drained.id;
    const pausedB = await waitForRun(mount.baseUrl, idB, ['paused']);
    expect(pausedB.pausedFor).toBe('hold');
    // Its first phase really executed through the executor.
    expect(pausedB.stateJson?.leafOutputs?.mark).toBe('mark:B');

    // Exactly ONE fire drained — C is still parked; B' now holds the group.
    expect(await mount.store.countPendingFires(GROUP)).toBe(1);
    const active = await mount.store.findActiveRunsInGroup(GROUP);
    expect(active.map(r => r.id)).toEqual([idB]);
  });

  it('bulk-cancel completes: cancel the new holder (drains C), cancel C — queue empty, nothing runs afterwards', async () => {
    await cancelRun(mount.baseUrl, idB);
    expect((await getRun(mount.baseUrl, idB)).status).toBe('cancelled');

    // Second drain: C starts + pauses at its lock.
    const drained = await findDrainedRun('C', [idA, idB]);
    idC = drained.id;
    await waitForRun(mount.baseUrl, idC, ['paused']);
    expect(await mount.store.countPendingFires(GROUP)).toBe(0);

    // Final cancel of the bulk sequence.
    await cancelRun(mount.baseUrl, idC);
    expect((await getRun(mount.baseUrl, idC)).status).toBe('cancelled');

    // The queued work must NOT run afterwards: give any stray drain a moment,
    // then assert quiescence — empty queue, no active holder, and exactly the
    // three known runs (no fourth ever materializes).
    await sleep(300);
    expect(await mount.store.countPendingFires(GROUP)).toBe(0);
    expect(await mount.store.findActiveRunsInGroup(GROUP)).toEqual([]);
    const runs = (await listRuns(mount.baseUrl)).filter(
      r => r.orchestrationName === ORCH,
    );
    expect(runs.length).toBe(3);
    expect(new Set(runs.map(r => r.id))).toEqual(new Set([idA, idB, idC]));
    for (const r of runs) expect(r.status).toBe('cancelled');
  });
});
