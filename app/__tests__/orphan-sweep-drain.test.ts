/**
 * The orphan sweep drains the concurrency group it frees.
 *
 * `markOrphanedRunsAsInterrupted` flips a dead peer's run running →
 * interrupted. `findActiveRunsInGroup` counts only running / paused, so that
 * flip FREES the run's concurrency slot — but freeing a slot starts nothing.
 * The three other terminal paths (executor terminal hook, cancel, gate
 * reject) all route through `releaseGroupAndDrainForRun`, which the file
 * itself calls "the SINGLE seam every terminal transition must route
 * through". The sweep was a fourth terminal transition that did not, so a
 * fire parked behind a dead peer's run waited forever: slot open, queue
 * untouched, every status surface healthy. The project's named failure class.
 *
 * Pinned on both sweep paths — boot and the periodic timer — against the real
 * mount, with a store whose lease TTL is short enough to expire in-test.
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
import { _resetForTests as _resetRunController } from '../src/server/run-controller';
import { approveGate, sleep, waitFor } from './lifecycle-harness.helpers';

jest.setTimeout(30_000);

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

const GROUP = 'peer-env';
/** Long enough that a drained code.source run never lapses mid-flight (its
 *  events renew the lease), short enough to expire in-test. */
const LEASE_MS = 500;
const SWEEP_MS = 200;

describe('orphan sweep → group drain', () => {
  let server: http.Server;
  let tmpRoot: string;
  let baseUrl: string;
  let store: SqliteRunStore;
  let peer: SqliteRunStore;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['SAMMY_DISABLE_INPROCESS_WORKER', 'DATABASE_URL', 'SAMMY_ORPHAN_SWEEP_MS', 'SAMMY_AUTO_RESUME'];

  const runsOf = async (orch: string) =>
    (await store.listRuns(100)).filter(r => r.orchestrationName === orch);

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.SAMMY_DISABLE_INPROCESS_WORKER = '1';
    delete process.env.DATABASE_URL;
    delete process.env.SAMMY_AUTO_RESUME;
    process.env.SAMMY_ORPHAN_SWEEP_MS = String(SWEEP_MS);
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-orphan-drain-'));
    await fs.mkdir(path.join(tmpRoot, 'examples'), { recursive: true });
    for (const name of ['dead-peer-orch', 'parked-orch']) {
      await fs.writeFile(
        path.join(tmpRoot, 'examples', `${name}.json`),
        JSON.stringify({
          name,
          concurrency: { group: GROUP, policy: 'queue' },
          phases: [{ name: 'p', code: { source: "return 'drained'" } }],
        }),
        'utf8',
      );
    }
    store = new SqliteRunStore(tmpRoot, { leaseTtlMs: LEASE_MS });
    await store.init();
    // The dead rows are seeded through a PEER handle with its own instance
    // id: a store never reclaims a `running` row it holds the lease on
    // itself (that would let a process's periodic sweep interrupt its own
    // stalled run), so the orphan must look like another process's.
    peer = new SqliteRunStore(tmpRoot, { leaseTtlMs: LEASE_MS, instanceId: 'dead-peer' });
    await peer.init();

    // A run "a peer was executing" when it died: still `running`, holding
    // the group, with a lease that lapses before the mount's boot scan. One
    // fire parked behind it — the work that used to wait forever.
    await peer.upsertRun({
      id: 'dead-peer-run',
      orchestrationName: 'dead-peer-orch',
      startedAt: Date.now() - 10_000,
      status: 'running',
      events: [{ type: 'run-start' }],
      concurrencyGroup: GROUP,
    });
    await store.enqueuePendingFire(GROUP, {
      orchName: 'parked-orch',
      initialInput: 'behind-boot-orphan',
      ownerId: 'system',
    });
    await sleep(LEASE_MS + 100);

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
    _resetRunController();
    await new Promise<void>(resolve => server.close(() => resolve()));
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await store.close();
    await peer.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('boot: the reclaimed run is interrupted AND the fire parked behind it was drained', async () => {
    expect((await store.getRun('dead-peer-run'))?.status).toBe('interrupted');
    // The drain hatches the parked fire through the normal start path.
    const drained = await waitFor(
      async () => (await runsOf('parked-orch')).find(r => r.initialInput === 'behind-boot-orphan') ?? null,
      'parked fire → run',
    );
    expect(await store.countPendingFires(GROUP)).toBe(0);
    await waitFor(
      async () => ((await store.getRunSummary(drained.id))?.status === 'done' ? true : null),
      'drained run → done',
    );
    // And the API still answers — nothing about the drain wedged the mount.
    expect((await fetch(`${baseUrl}/api/livez`)).status).toBe(200);
  });

  it('periodic sweep: a peer dying while this process stays up gets the same treatment', async () => {
    // Make sure the boot-drained run has released the group first, so the
    // new fire parks behind THIS holder and not that one.
    await waitFor(
      async () => ((await store.findActiveRunsInGroup(GROUP)).length === 0 ? true : null),
      'group idle after boot drain',
    );
    await peer.upsertRun({
      id: 'dead-peer-run-2',
      orchestrationName: 'dead-peer-orch',
      startedAt: Date.now(),
      status: 'running',
      events: [{ type: 'run-start' }],
      concurrencyGroup: GROUP,
    });
    await store.enqueuePendingFire(GROUP, {
      orchName: 'parked-orch',
      initialInput: 'behind-periodic-orphan',
      ownerId: 'system',
    });
    // Lease lapses after LEASE_MS; the sweeper fires every SWEEP_MS.
    const drained = await waitFor(
      async () =>
        (await runsOf('parked-orch')).find(r => r.initialInput === 'behind-periodic-orphan') ?? null,
      'periodic sweep drained the parked fire',
      { timeoutMs: 10_000, intervalMs: 50 },
    );
    expect((await store.getRun('dead-peer-run-2'))?.status).toBe('interrupted');
    expect(await store.countPendingFires(GROUP)).toBe(0);
    await waitFor(
      async () => ((await store.getRunSummary(drained.id))?.status === 'done' ? true : null),
      'periodic drained run → done',
    );
  });
});

describe('orphan sweep with SAMMY_AUTO_RESUME=1 → resume first, drain after', () => {
  // The sweep drained every reclaimed run's group BEFORE the auto-resume
  // loop: the drained fire took the group, resume() refused ("group busy"),
  // and nothing retried — crash-resume was lost exactly when the group had
  // queued work. The interrupted run must resume, and the parked fire must
  // run AFTER it, through the resumed run's own terminal drain.
  let server: http.Server;
  let tmpRoot: string;
  let store: SqliteRunStore;
  let peer: SqliteRunStore;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['SAMMY_DISABLE_INPROCESS_WORKER', 'DATABASE_URL', 'SAMMY_ORPHAN_SWEEP_MS', 'SAMMY_AUTO_RESUME'];

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.SAMMY_DISABLE_INPROCESS_WORKER = '1';
    delete process.env.DATABASE_URL;
    delete process.env.SAMMY_ORPHAN_SWEEP_MS;
    process.env.SAMMY_AUTO_RESUME = '1';
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-orphan-resume-'));
    await fs.mkdir(path.join(tmpRoot, 'examples'), { recursive: true });
    for (const name of ['dead-peer-orch', 'parked-orch']) {
      await fs.writeFile(
        path.join(tmpRoot, 'examples', `${name}.json`),
        JSON.stringify({
          name,
          concurrency: { group: GROUP, policy: 'queue' },
          phases: [{ name: 'p', code: { source: `return '${name}'` } }],
        }),
        'utf8',
      );
    }
    store = new SqliteRunStore(tmpRoot, { leaseTtlMs: LEASE_MS });
    await store.init();
    peer = new SqliteRunStore(tmpRoot, { leaseTtlMs: LEASE_MS, instanceId: 'dead-peer' });
    await peer.init();
    await peer.upsertRun({
      id: 'dead-peer-run',
      orchestrationName: 'dead-peer-orch',
      startedAt: Date.now() - 10_000,
      status: 'running',
      events: [{ type: 'run-start' }],
      concurrencyGroup: GROUP,
    });
    await store.enqueuePendingFire(GROUP, {
      orchName: 'parked-orch',
      initialInput: 'behind-resumed-orphan',
      ownerId: 'system',
    });
    await sleep(LEASE_MS + 100);

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
  });

  afterAll(async () => {
    destroyAllCronTasks();
    _resetRunController();
    await new Promise<void>(resolve => server.close(() => resolve()));
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await store.close();
    await peer.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('the interrupted run resumes and the parked fire runs after it', async () => {
    // Pre-fix: the parked fire was drained first and held the group, the
    // resume was refused as "group busy", and the run sat `interrupted`.
    const resumed = await waitFor(
      async () => {
        const r = await store.getRun('dead-peer-run');
        return r?.status === 'done' ? r : null;
      },
      'interrupted run auto-resumed to done',
    );
    expect(resumed.events.some(e => e.type === 'run-resumed')).toBe(true);
    expect(resumed.lastOutput).toBe('dead-peer-orch');

    const parked = await waitFor(
      async () =>
        (await store.listRuns(100)).find(r => r.initialInput === 'behind-resumed-orphan') ?? null,
      'parked fire → run',
    );
    // Hatched by the resumed run's terminal, so strictly after it ended.
    expect(parked.startedAt).toBeGreaterThanOrEqual(resumed.endedAt!);
    await waitFor(
      async () => ((await store.getRunSummary(parked.id))?.status === 'done' ? true : null),
      'parked run → done',
    );
    expect(await store.countPendingFires(GROUP)).toBe(0);
  });
});

describe('orphan sweep with SAMMY_AUTO_RESUME=1 → a NOT-resumed orphan does not drain into a held group', () => {
  // Two orphans in one group. One resumes and re-takes the group (it pauses
  // at a lock, so it HOLDS it for as long as the case needs); the other
  // cannot resume — its orchestration is gone from the workspace — and so
  // reaches the post-resume drain pass. That pass must skip a group that is
  // busy: draining into it would re-park a `queue` fire at best, and here,
  // with a `skip`-policy fire parked behind the group, DROP it — the fire
  // is dequeued, the policy sees the resumed holder, and the work is gone.
  // The holder's own terminal drains the queue; nothing else may.
  let server: http.Server;
  let baseUrl: string;
  let tmpRoot: string;
  let store: SqliteRunStore;
  let peer: SqliteRunStore;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['SAMMY_DISABLE_INPROCESS_WORKER', 'DATABASE_URL', 'SAMMY_ORPHAN_SWEEP_MS', 'SAMMY_AUTO_RESUME'];

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.SAMMY_DISABLE_INPROCESS_WORKER = '1';
    delete process.env.DATABASE_URL;
    delete process.env.SAMMY_ORPHAN_SWEEP_MS;
    process.env.SAMMY_AUTO_RESUME = '1';
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-orphan-busy-'));
    await fs.mkdir(path.join(tmpRoot, 'examples'), { recursive: true });
    // The resumable orphan's orchestration pauses at a lock, so the resumed
    // run holds the group until the case approves it.
    await fs.writeFile(
      path.join(tmpRoot, 'examples', 'resumable-orch.json'),
      JSON.stringify({
        name: 'resumable-orch',
        concurrency: { group: GROUP, policy: 'queue' },
        phases: [{ name: 'p', code: { source: "return 'resumed'" }, lock: true }],
      }),
      'utf8',
    );
    // The parked fire's policy is `skip`: drained into a busy group it is
    // not re-parked but dropped — the loudest shape of the bug.
    await fs.writeFile(
      path.join(tmpRoot, 'examples', 'skip-orch.json'),
      JSON.stringify({
        name: 'skip-orch',
        concurrency: { group: GROUP, policy: 'skip' },
        phases: [{ name: 'p', code: { source: "return 'skipped-orch-ran'" } }],
      }),
      'utf8',
    );
    store = new SqliteRunStore(tmpRoot, { leaseTtlMs: LEASE_MS });
    await store.init();
    peer = new SqliteRunStore(tmpRoot, { leaseTtlMs: LEASE_MS, instanceId: 'dead-peer' });
    await peer.init();
    await peer.upsertRun({
      id: 'resumable-run',
      orchestrationName: 'resumable-orch',
      startedAt: Date.now() - 10_000,
      status: 'running',
      events: [{ type: 'run-start' }],
      concurrencyGroup: GROUP,
    });
    // No `gone-orch.json` in the workspace and no snapshot on the row: the
    // resume pass cannot build its context and leaves this one interrupted.
    await peer.upsertRun({
      id: 'unresumable-run',
      orchestrationName: 'gone-orch',
      startedAt: Date.now() - 10_000,
      status: 'running',
      events: [{ type: 'run-start' }],
      concurrencyGroup: GROUP,
    });
    await store.enqueuePendingFire(GROUP, {
      orchName: 'skip-orch',
      initialInput: 'behind-held-group',
      ownerId: 'system',
    });
    await sleep(LEASE_MS + 100);

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
    _resetRunController();
    await new Promise<void>(resolve => server.close(() => resolve()));
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await store.close();
    await peer.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('the parked fire stays parked behind the resumed holder, and runs at its terminal', async () => {
    // The resumed run re-took the group and is holding it at its lock.
    const holder = await waitFor(
      async () => {
        const r = await store.getRun('resumable-run');
        return r?.status === 'paused' ? r : null;
      },
      'resumed run holds the group at its lock',
    );
    expect(holder.events.some(e => e.type === 'run-resumed')).toBe(true);
    expect((await store.getRun('unresumable-run'))?.status).toBe('interrupted');

    // Pre-fix: the not-resumed orphan's drain pass fired the parked
    // `skip` fire into the held group — dequeued, skipped, gone — while the
    // holder sat paused. Give the sweep every chance to have done so.
    await sleep(300);
    expect(await store.countPendingFires(GROUP)).toBe(1);
    expect(
      (await store.listRuns(100)).find(r => r.initialInput === 'behind-held-group'),
    ).toBeUndefined();
    expect((await store.getRun('resumable-run'))?.status).toBe('paused');

    // The holder's own terminal is what drains it.
    await approveGate(baseUrl, 'resumable-run');
    await waitFor(
      async () => ((await store.getRunSummary('resumable-run'))?.status === 'done' ? true : null),
      'resumed holder → done',
    );
    const hatched = await waitFor(
      async () =>
        (await store.listRuns(100)).find(r => r.initialInput === 'behind-held-group') ?? null,
      'parked fire → run after the holder\'s terminal',
    );
    await waitFor(
      async () => ((await store.getRunSummary(hatched.id))?.status === 'done' ? true : null),
      'hatched run → done',
    );
    expect(await store.countPendingFires(GROUP)).toBe(0);
  });
});
