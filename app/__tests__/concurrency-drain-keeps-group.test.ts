/**
 * A drained fire holds the group it was drained FROM, so the queue keeps
 * advancing on its own.
 *
 * `drainPendingFire` starts the fire through `fireRun(…, 'concurrency-drain',
 * …)`, and `effectiveConcurrency` hands out the implicit `sammy:cron:<name>`
 * group only for kind `cron` — so the drained run used to be created with NO
 * group. That is a LIVENESS defect on top of the overlap one: the drained
 * run's own terminal read a null group and drained
 * nothing, so a backlog of N parked fires advanced by at most one per later
 * cron tick, and not at all once ticks stopped (the trigger edited away, the
 * orchestration deleted, the breaker auto-pausing the cron). No sweep drains a
 * pending-fire queue — every drain path is keyed on a RUN's `concurrencyGroup`
 * — so the remainder was stranded with `GET /api/concurrency` reporting
 * `held: false` beside a non-empty `queued` and no warning anywhere, while the
 * delivery row said `deferred: parked on the pending queue`.
 *
 * Only the IMPLICIT cron group was affected: an explicit root `concurrency`
 * block wins for every kind, so those drained runs were always stamped. That
 * is why `lifecycle-cancel-queue.test.ts` stayed green — the control case
 * below is the explicit twin, kept here so the two shapes are compared in one
 * place.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import connect from 'connect';
import { mountSammyApi } from '../sammy-pack-api';
import { _resetForTests } from '../src/server/run-controller';
import { SqliteRunStore } from '../src/server/db';
import { pinTestEnv } from './lifecycle-harness.helpers';

jest.setTimeout(45_000);

const IMPLICIT = 'cronq';
const IMPLICIT_GROUP = `sammy:cron:${IMPLICIT}`;
const EXPLICIT = 'expq';
const EXPLICIT_GROUP = 'expq-g';

describe('a drained fire keeps the group it was parked under', () => {
  let server: http.Server;
  let tmpRoot: string;
  let baseUrl: string;
  let store: SqliteRunStore;
  let restoreEnv: () => void;

  async function until<T>(probe: () => Promise<T | false>, label: string): Promise<T> {
    for (let i = 0; i < 200; i += 1) {
      const v = await probe();
      if (v) return v;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`condition not reached: ${label}`);
  }

  /** A `running` holder of `group`, with no live controller in this process —
   *  so /cancel takes the store path and drains through the shared seam. */
  async function seedHolder(id: string, group: string): Promise<void> {
    await store.upsertRun({
      id,
      orchestrationName: 'holder-orch',
      startedAt: Date.now() - 1_000,
      status: 'running',
      events: [],
      concurrencyGroup: group,
    });
  }

  const park = async (group: string, orchName: string, input: string): Promise<void> => {
    await store.enqueuePendingFire(group, {
      orchName,
      initialInput: input,
      ownerId: 'system',
    });
  };

  const runsOf = async (orchName: string) =>
    (await store.listRuns(50)).filter(r => r.orchestrationName === orchName);

  beforeEach(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-drain-group-'));
    await fs.mkdir(path.join(tmpRoot, 'examples'), { recursive: true });
    // Implicit group only: a cron trigger with `overlap: 'queue'` and NO root
    // `concurrency` block. The expr is deliberately far away — the point is
    // that the queue must advance with no further tick.
    await fs.writeFile(
      path.join(tmpRoot, 'examples', `${IMPLICIT}.json`),
      JSON.stringify({
        name: IMPLICIT,
        triggers: [{ kind: 'cron', expr: '0 0 1 1 *', overlap: 'queue' }],
        phases: [{ name: 'p', code: { source: "return 'ran:' + input" } }],
      }),
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpRoot, 'examples', `${EXPLICIT}.json`),
      JSON.stringify({
        name: EXPLICIT,
        concurrency: { group: EXPLICIT_GROUP, policy: 'queue' },
        phases: [{ name: 'p', code: { source: "return 'ran:' + input" } }],
      }),
      'utf8',
    );
    store = new SqliteRunStore(tmpRoot);
    await store.init();
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

  afterEach(async () => {
    _resetForTests();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await store.close();
    restoreEnv?.();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('drains TWO fires behind an implicit cron group with no further tick', async () => {
    await seedHolder('holder-implicit', IMPLICIT_GROUP);
    await park(IMPLICIT_GROUP, IMPLICIT, 'A');
    await park(IMPLICIT_GROUP, IMPLICIT, 'B');
    expect(await store.countPendingFires(IMPLICIT_GROUP)).toBe(2);

    // ONE terminal. Everything after this must happen without a cron tick.
    const cancelled = await fetch(`${baseUrl}/api/runs/holder-implicit/cancel`, {
      method: 'POST',
    });
    expect(cancelled.status).toBe(200);

    // Fire A drains, holds the group, finishes — and ITS terminal drains B.
    const done = await until(
      async () => {
        const rs = await runsOf(IMPLICIT);
        return rs.length === 2 && rs.every(r => r.status === 'done') ? rs : false;
      },
      'both parked fires to run',
    );
    expect(done.map(r => r.lastOutput).sort()).toEqual(['ran:A', 'ran:B']);
    // Each drained run is a real HOLDER of the group — that is what makes the
    // next drain possible, and what makes the next cron tick park rather than
    // overlap an ungated run.
    for (const r of done) expect(r.concurrencyGroup).toBe(IMPLICIT_GROUP);
    expect(await store.countPendingFires(IMPLICIT_GROUP)).toBe(0);
    // Nothing is left looking busy afterwards.
    expect(await store.findActiveRunsInGroup(IMPLICIT_GROUP)).toEqual([]);
  });

  it('the /api/concurrency view ends with the group free and the queue empty', async () => {
    await seedHolder('holder-view', IMPLICIT_GROUP);
    await park(IMPLICIT_GROUP, IMPLICIT, 'A');
    await park(IMPLICIT_GROUP, IMPLICIT, 'B');
    await fetch(`${baseUrl}/api/runs/holder-view/cancel`, { method: 'POST' });
    await until(
      async () => (await store.countPendingFires(IMPLICIT_GROUP)) === 0,
      'the queue to empty',
    );
    type Row = { group: string; held: boolean; queued: unknown[] };
    const rows = (await (await fetch(`${baseUrl}/api/concurrency`)).json()) as Row[];
    const row = rows.find(r => r.group === IMPLICIT_GROUP);
    // The silent-stall shape was `held: false` WITH a non-empty queue and no
    // warning: a free group whose accepted work never ran.
    expect(row?.queued ?? []).toEqual([]);
    expect(row?.held ?? false).toBe(false);
  });

  it('CONTROL: an explicit root concurrency block behaves the same', async () => {
    await seedHolder('holder-explicit', EXPLICIT_GROUP);
    await park(EXPLICIT_GROUP, EXPLICIT, 'A');
    await park(EXPLICIT_GROUP, EXPLICIT, 'B');
    const cancelled = await fetch(`${baseUrl}/api/runs/holder-explicit/cancel`, {
      method: 'POST',
    });
    expect(cancelled.status).toBe(200);
    const done = await until(
      async () => {
        const rs = await runsOf(EXPLICIT);
        return rs.length === 2 && rs.every(r => r.status === 'done') ? rs : false;
      },
      'both parked fires to run',
    );
    for (const r of done) expect(r.concurrencyGroup).toBe(EXPLICIT_GROUP);
    expect(await store.countPendingFires(EXPLICIT_GROUP)).toBe(0);
  });
});
