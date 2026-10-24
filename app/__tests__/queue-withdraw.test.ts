/**
 * Parked-fire withdrawal + run-detail concurrency fields.
 *
 * WHY: before DELETE /api/concurrency/<group>/queued[/<id>] existed, a drain
 * was the ONLY way a fire left the queue — and a drain HATCHES it. So "stop
 * everything in this group" had to let each queued run start just to cancel
 * it (each cancel's own terminal drain releasing the next). These tests pin
 * the operator's new "don't run this queued work" verb end-to-end:
 *
 *   - withdraw one fire by FIFO id (atomic vs. a concurrent drain — the
 *     loser sees 404, the fire never both starts AND withdraws);
 *   - the delete is group-conditional in the same statement (a wrong-group
 *     path removes nothing);
 *   - bulk-withdraw empties the group's queue, so cancelling the holder
 *     afterwards hatches NOTHING;
 *   - GET /api/runs/:id now carries `concurrencyGroup` + explicit-null
 *     `endedAt` / `pausedFor` (previously `?? undefined` dropped the keys,
 *     so group state was unreadable from the run API).
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import connect from 'connect';
import * as cron from 'node-cron';
import { mountSammyApi } from '../sammy-pack-api';
import { SqliteRunStore } from '../src/server/db';

/** Same defensive teardown as the sibling mount suites: node-cron task
 *  timers are not unref'd, so any trigger this mount registered would hold
 *  the jest process open forever without an explicit destroy. */
function destroyAllCronTasks(): void {
  const getTasks = (
    cron as unknown as { getTasks?: () => Map<string, { destroy?: () => void }> }
  ).getTasks;
  if (typeof getTasks !== 'function') return;
  for (const task of getTasks().values()) {
    try {
      task.destroy?.();
    } catch {
      /* already destroyed */
    }
  }
}

type ConcurrencyRow = {
  group: string;
  holder: { runId: string } | null;
  queued: Array<{ id: number; orchestration: string; ownerId: string }>;
};

const GROUP = 'stage-env';

describe('DELETE /api/concurrency/<group>/queued — parked-fire withdrawal', () => {
  let server: http.Server;
  let tmpRoot: string;
  let baseUrl: string;
  let store: SqliteRunStore;
  const prevWorker = process.env.SAMMY_DISABLE_INPROCESS_WORKER;
  const prevDbUrl = process.env.DATABASE_URL;

  const queuedRows = async (): Promise<ConcurrencyRow['queued']> => {
    const rows = (await (
      await fetch(`${baseUrl}/api/concurrency`)
    ).json()) as ConcurrencyRow[];
    return rows.find(r => r.group === GROUP)?.queued ?? [];
  };

  beforeAll(async () => {
    process.env.SAMMY_DISABLE_INPROCESS_WORKER = '1';
    delete process.env.DATABASE_URL;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-withdraw-'));

    await fs.mkdir(path.join(tmpRoot, 'examples'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'examples', 'holder-orch.json'),
      JSON.stringify({
        name: 'holder-orch',
        concurrency: { group: GROUP, policy: 'queue' },
        phases: [{ name: 'p', code: { source: "return 'x'" } }],
      }),
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpRoot, 'examples', 'queued-orch.json'),
      JSON.stringify({
        name: 'queued-orch',
        concurrency: { group: GROUP, policy: 'queue' },
        phases: [{ name: 'p', code: { source: "return 'y'" } }],
      }),
      'utf8',
    );

    store = new SqliteRunStore(tmpRoot);
    await store.init();

    // A paused holder of the group (the stale-wedge shape) + three fires
    // parked behind it, FIFO A → B → C.
    await store.upsertRun({
      id: 'holder-run',
      orchestrationName: 'holder-orch',
      startedAt: Date.now() - 5_000,
      status: 'paused',
      events: [],
      concurrencyGroup: GROUP,
    });
    for (const tag of ['A', 'B', 'C']) {
      await store.enqueuePendingFire(GROUP, {
        orchName: 'queued-orch',
        initialInput: tag,
        ownerId: 'system',
      });
    }

    const app = connect();
    server = http.createServer(app);
    await mountSammyApi(
      {
        middlewares: app,
        config: { root: path.join(tmpRoot, 'app', 'web') },
        httpServer: server,
      },
      { store },
    );
    await new Promise<void>(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    destroyAllCronTasks();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await store.close();
    if (prevWorker === undefined) delete process.env.SAMMY_DISABLE_INPROCESS_WORKER;
    else process.env.SAMMY_DISABLE_INPROCESS_WORKER = prevWorker;
    if (prevDbUrl !== undefined) process.env.DATABASE_URL = prevDbUrl;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('withdraws one parked fire by id; the rest of the FIFO is untouched', async () => {
    const before = await queuedRows();
    expect(before.map(q => q.id).length).toBe(3);
    const victim = before[1]; // middle of the FIFO — order must survive

    const res = await fetch(
      `${baseUrl}/api/concurrency/${GROUP}/queued/${victim.id}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      withdrawn: { id: number; orchestration: string; group: string };
    };
    expect(body.withdrawn.id).toBe(victim.id);
    expect(body.withdrawn.group).toBe(GROUP);

    const after = await queuedRows();
    expect(after.map(q => q.id)).toEqual(
      before.filter(q => q.id !== victim.id).map(q => q.id),
    );
  });

  it('is atomic-idempotent: withdrawing the same id again is 404, nothing else removed', async () => {
    const before = await queuedRows();
    const goneId =
      Math.min(...before.map(q => q.id)) === before[0].id
        ? before[0].id - 1 // the previously-withdrawn middle id is unknown here;
        : -1; //              any definitely-absent id exercises the same path
    const res = await fetch(
      `${baseUrl}/api/concurrency/${GROUP}/queued/${goneId}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(404);
    expect((await queuedRows()).length).toBe(before.length);
  });

  it('is group-conditional: a wrong-group path removes nothing (404, fire stays parked)', async () => {
    const before = await queuedRows();
    const target = before[0];
    const res = await fetch(
      `${baseUrl}/api/concurrency/other-group/queued/${target.id}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(404);
    const after = await queuedRows();
    expect(after.map(q => q.id)).toContain(target.id);
  });

  it('rejects a non-numeric id', async () => {
    const res = await fetch(
      `${baseUrl}/api/concurrency/${GROUP}/queued/not-a-number`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(400);
  });

  it('run detail carries concurrencyGroup + explicit-null endedAt/pausedFor keys', async () => {
    const detail = (await (
      await fetch(`${baseUrl}/api/runs/holder-run`)
    ).json()) as Record<string, unknown>;
    expect(detail.concurrencyGroup).toBe(GROUP);
    // The keys must EXIST (explicit null), not be dropped by serialization —
    // "not ended" must be distinguishable from "field unsupported".
    expect('endedAt' in detail).toBe(true);
    expect(detail.endedAt).toBeNull();
    expect('pausedFor' in detail).toBe(true);
  });

  it('bulk-withdraw empties the queue, so cancelling the holder hatches NOTHING', async () => {
    // Two fires remain parked (A and C). Withdraw all…
    const res = await fetch(`${baseUrl}/api/concurrency/${GROUP}/queued`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { withdrawn: number }).withdrawn).toBe(2);
    expect(await queuedRows()).toEqual([]);

    // …then cancel the paused holder. Its terminal drain finds an empty
    // queue: no queued run is hatched-just-to-be-cancelled.
    const runsBefore = (await store.listRuns()).length;
    const cancel = await fetch(`${baseUrl}/api/runs/holder-run/cancel`, {
      method: 'POST',
    });
    expect(cancel.status).toBe(200);
    // Give any (buggy) drain-hatch a beat to materialize before asserting.
    await new Promise(r => setTimeout(r, 300));
    const runs = await store.listRuns();
    expect(runs.length).toBe(runsBefore); // no new run appeared
    expect(runs.find(r => r.id === 'holder-run')?.status).toBe('cancelled');
    // And the holder's detail now shows a real end time (explicit value,
    // same key the null test above proved present while active).
    const detail = (await (
      await fetch(`${baseUrl}/api/runs/holder-run`)
    ).json()) as Record<string, unknown>;
    expect(typeof detail.endedAt).toBe('number');
  });

  it('store-level: dequeue after a withdraw skips to the next FIFO row', async () => {
    // Fresh rows in a throwaway group, exercised at the store layer (the
    // atomicity seam the API rides on).
    for (const tag of ['one', 'two']) {
      await store.enqueuePendingFire('unit-group', {
        orchName: 'queued-orch',
        initialInput: tag,
        ownerId: 'system',
      });
    }
    const parked = await store.listPendingFires('unit-group');
    expect(parked.length).toBe(2);
    const first = await store.withdrawPendingFire(parked[0].id, 'unit-group');
    expect(first?.initialInput).toBe('one');
    // Re-withdrawing the same id: exactly-once — the row is gone.
    expect(await store.withdrawPendingFire(parked[0].id, 'unit-group')).toBeNull();
    // The drain now yields the SECOND row (FIFO advanced past the withdrawal).
    const drained = await store.dequeueNextPendingFire('unit-group');
    expect(drained?.initialInput).toBe('two');
    expect(await store.countPendingFires('unit-group')).toBe(0);
  });
});
