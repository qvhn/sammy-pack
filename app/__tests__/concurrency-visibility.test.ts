/**
 * Concurrency-queue visibility. The queue state used to be INVISIBLE: a
 * (possibly stale-paused) holder kept its group while cron fires parked
 * silently behind it — the only trace was one console.log. These tests pin
 * the two observability surfaces:
 *
 *   - GET /api/concurrency → one row per known group with the current
 *     holder (oldest active run), the parked FIFO, and the declared policy;
 *   - GET /api/triggers    → a trigger whose orchestration's group is
 *     currently HELD carries `blockedBy` (run id + group + held-since), so
 *     "why didn't my cron run" is answerable from the endpoint the operator
 *     already checks.
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

/** The mount registers this suite's cron trigger with node-cron, whose task
 *  timer is NOT unref'd — when jest runs this suite in-band, that live timer
 *  would keep the process open forever. Destroy every scheduled task at
 *  teardown (same defensive shape as the mount's own leak sweeper). */
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
  holder: {
    runId: string;
    orchestration: string;
    status: string;
    heldSinceMs: number;
  } | null;
  queued: Array<{
    id: number;
    orchestration: string;
    ownerId: string;
    queuedSinceMs: number;
  }>;
  policy: string | null;
};

type TriggerRow = {
  kind: string;
  name: string;
  orchestration: string;
  blockedBy?: { runId: string; group: string; heldSinceMs: number };
};

describe('GET /api/concurrency + trigger blockedBy', () => {
  let server: http.Server;
  let tmpRoot: string;
  let baseUrl: string;
  let store: SqliteRunStore;
  let holderStartedAt: number;
  const prevWorker = process.env.SAMMY_DISABLE_INPROCESS_WORKER;
  const prevDbUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.SAMMY_DISABLE_INPROCESS_WORKER = '1';
    delete process.env.DATABASE_URL;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-conc-vis-'));

    // Workspace: a manual holder orch + a cron orch, BOTH in group
    // 'stage-env' (queue policy), plus an idle declared group. Written
    // before mount so the boot trigger scan registers the declarations.
    await fs.mkdir(path.join(tmpRoot, 'examples'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'examples', 'holder-orch.json'),
      JSON.stringify({
        name: 'holder-orch',
        concurrency: { group: 'stage-env', policy: 'queue' },
        phases: [{ name: 'p', code: { source: "return 'x'" } }],
      }),
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpRoot, 'examples', 'cron-orch.json'),
      JSON.stringify({
        name: 'cron-orch',
        concurrency: { group: 'stage-env' }, // policy defaults to 'queue'
        triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
        phases: [{ name: 'p', code: { source: "return 'y'" } }],
      }),
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpRoot, 'examples', 'idle-orch.json'),
      JSON.stringify({
        name: 'idle-orch',
        concurrency: { group: 'idle-env', policy: 'skip' },
        phases: [{ name: 'p', code: { source: "return 'z'" } }],
      }),
      'utf8',
    );

    store = new SqliteRunStore(tmpRoot);
    await store.init();

    // An ACTIVE holder of 'stage-env' + two fires parked behind it (FIFO).
    holderStartedAt = Date.now() - 5_000;
    await store.upsertRun({
      id: 'holder-run',
      orchestrationName: 'holder-orch',
      startedAt: holderStartedAt,
      status: 'running',
      events: [],
      concurrencyGroup: 'stage-env',
    });
    await store.enqueuePendingFire('stage-env', {
      orchName: 'cron-orch',
      initialInput: 'first',
      ownerId: 'system',
    });
    await store.enqueuePendingFire('stage-env', {
      orchName: 'cron-orch',
      initialInput: 'second',
      ownerId: 'alice',
    });

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

  it('reports the holder, the FIFO queue, and the policy for a held group', async () => {
    const res = await fetch(`${baseUrl}/api/concurrency`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as ConcurrencyRow[];

    const held = rows.find(r => r.group === 'stage-env');
    expect(held).toBeDefined();
    expect(held!.holder).toEqual({
      runId: 'holder-run',
      orchestration: 'holder-orch',
      status: 'running',
      heldSinceMs: holderStartedAt, // epoch — when the hold began
    });
    expect(held!.policy).toBe('queue');
    // FIFO order (the dequeue order), each with its parked-at epoch. The
    // view is OWNER-SCOPED: this headerless call is `system`, so alice's
    // parked fire is not in it (concurrency-owner-scoping.test.ts pins the
    // per-owner views); the holder is system-owned, so it IS shown.
    expect(held!.queued.map(q => q.orchestration)).toEqual(['cron-orch']);
    expect(held!.queued.map(q => q.ownerId)).toEqual(['system']);
    for (const q of held!.queued) {
      expect(typeof q.queuedSinceMs).toBe('number');
      expect(q.queuedSinceMs).toBeLessThanOrEqual(Date.now());
    }
  });

  it('shows a declared-but-idle group as free (holder null, queue empty)', async () => {
    const rows = (await (
      await fetch(`${baseUrl}/api/concurrency`)
    ).json()) as ConcurrencyRow[];
    const idle = rows.find(r => r.group === 'idle-env');
    expect(idle).toBeDefined();
    expect(idle!.holder).toBeNull();
    expect(idle!.queued).toEqual([]);
    expect(idle!.policy).toBe('skip');
  });

  it('rejects non-GET', async () => {
    const res = await fetch(`${baseUrl}/api/concurrency`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('GET /api/triggers carries blockedBy on the cron whose group is held', async () => {
    const res = await fetch(`${baseUrl}/api/triggers`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as TriggerRow[];
    const cronRow = list.find(
      t => t.kind === 'cron' && t.orchestration === 'cron-orch',
    );
    expect(cronRow).toBeDefined();
    expect(cronRow!.blockedBy).toEqual({
      runId: 'holder-run',
      group: 'stage-env',
      heldSinceMs: holderStartedAt,
    });
  });

  it('blockedBy disappears once the holder goes terminal', async () => {
    // Free the group directly (terminal status counts as released; the drain
    // path is covered by the cancel-semantics suite).
    await store.updateRunStatus('holder-run', {
      status: 'done',
      endedAt: Date.now(),
    });

    const list = (await (
      await fetch(`${baseUrl}/api/triggers`)
    ).json()) as TriggerRow[];
    const cronRow = list.find(
      t => t.kind === 'cron' && t.orchestration === 'cron-orch',
    );
    expect(cronRow!.blockedBy).toBeUndefined();

    const rows = (await (
      await fetch(`${baseUrl}/api/concurrency`)
    ).json()) as ConcurrencyRow[];
    const held = rows.find(r => r.group === 'stage-env');
    // Group now free — but the parked fires are still visible (they drain on
    // the next terminal via the drain path, not by this read-only endpoint).
    // One, not two: the caller (system) sees its own; alice's is hers.
    expect(held!.holder).toBeNull();
    expect(held!.queued).toHaveLength(1);
  });
});
