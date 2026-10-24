/**
 * A run whose terminal write fails every retry, in the single-process
 * topology: the SAME server's periodic orphan sweep reclaims it.
 *
 * After three failed status writes the leg tears itself down — heartbeat
 * stopped, controller gone — but the row still reads `running` under this
 * process's own lease. The sweep's own-row exclusion (right for a live run
 * with a blocked event loop) then protected it forever: no peer exists here
 * to take it, `findActiveRunsInGroup` counted it, and every later fire for
 * its group was refused or parked until a restart. The sweep now spares an
 * own row only while a controller still drives it, through the real mount's
 * sweeper — and the reclaim drains the group like any other terminal.
 */

import { promises as fs } from 'node:fs';
import { SqliteRunStore } from '../src/server/db';
import { isActive } from '../src/server/run-controller';
import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  waitFor,
  waitForRun,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(60_000);

const GROUP = 'reclaim-group';
const VICTIM = 'reclaim-victim';
const DRAINED = 'reclaim-drained';

describe('a terminal write that keeps failing, with no peer to reclaim the row', () => {
  let restoreEnv: () => void;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    // The real periodic sweeper, at a cadence the test can wait on.
    process.env.SAMMY_ORPHAN_SWEEP_MS = '150';
    const tmpRoot = await makeWorkspace('terminal-write-reclaim');
    await writeOrchestration(tmpRoot, {
      name: VICTIM,
      concurrency: { group: GROUP, policy: 'queue' },
      phases: [{ name: 'p', code: { source: "return 'victim'" } }],
    });
    await writeOrchestration(tmpRoot, {
      name: DRAINED,
      phases: [{ name: 'p', code: { source: "return 'drained:' + input" } }],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    await fs.rm(mount.tmpRoot, { recursive: true, force: true });
    restoreEnv?.();
  });

  it("is reclaimed by this process's own sweep once the lease lapses, and its group drains", async () => {
    // The terminal (`done`) status write fails the way a busy SQLite file
    // does — every time, while armed. Everything else about the store is
    // real; disarmed once the victim has given up so the drained run below
    // can finish.
    let armed = true;
    const real = SqliteRunStore.prototype.updateRunStatus;
    mount.store.updateRunStatus = async function (this: SqliteRunStore, id, patch, opts) {
      if (armed && patch.status === 'done') throw new Error('SQLITE_BUSY: database is locked');
      return real.call(this, id, patch, opts);
    };

    const started = await fetch(`${mount.baseUrl}/api/runs/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orchestrationName: VICTIM }),
    });
    expect(started.status).toBe(200);
    const { id } = (await started.json()) as { id: string };
    expect(id).toBeTruthy();

    // The leg gives up (bounded retries) and tears down …
    await waitFor(async () => (isActive(id) ? null : true), 'the leg to give up', {
      timeoutMs: 15_000,
    });
    armed = false;
    // … leaving the row `running` under THIS process's lease, group held.
    const db = (mount.store as unknown as {
      db: { prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown } };
    }).db;
    expect((await mount.store.getRunSummary(id))?.status).toBe('running');
    expect(
      (db.prepare('SELECT lease_owner FROM runs WHERE id = ?').get(id) as { lease_owner: string })
        .lease_owner,
    ).toBe((mount.store as unknown as { instanceId: string }).instanceId);
    expect((await mount.store.findActiveRunsInGroup(GROUP)).map(r => r.id)).toEqual([id]);
    // A fire arrives for the group: parked behind the abandoned row.
    await mount.store.enqueuePendingFire(GROUP, {
      orchName: DRAINED,
      initialInput: 'C',
      ownerId: 'system',
    });

    // The lease lapses. (Backdated rather than waited for — the TTL is two
    // minutes.) Pre-fix the sweeper ran every 150ms and reclaimed nothing:
    // the row was its own instance's.
    db.prepare('UPDATE runs SET lease_expires_at = ? WHERE id = ?').run(Date.now() - 1, id);
    await waitForRun(mount.baseUrl, id, ['interrupted'], undefined, 'own sweep reclaims it');

    // The reclaim released the group and drained the parked fire.
    expect(await mount.store.findActiveRunsInGroup(GROUP)).toEqual([]);
    const drained = await waitFor(
      async () =>
        (await mount.store.listRuns(50)).find(
          r => r.orchestrationName === DRAINED && r.status === 'done',
        ) ?? null,
      'the parked fire to run',
    );
    expect(drained.lastOutput).toBe('drained:C');
    expect(await mount.store.countPendingFires(GROUP)).toBe(0);
  });
});
