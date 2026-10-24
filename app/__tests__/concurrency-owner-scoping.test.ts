/**
 * /api/concurrency is owner-scoped: details for what you own, "busy" for the
 * rest, and no withdrawing another tenant's parked work.
 *
 * GET returned, from an unscoped scan, every group's holder run id /
 * orchestration / status and every queued fire's ownerId — an enumeration of
 * other tenants' identities and in-flight work from one anonymous read. And
 * DELETE /api/concurrency/<group>/queued[/<id>] withdrew parked fires with no
 * owner check at all. The group NAME and a boolean `held` stay visible to
 * everyone (a group is a workspace declaration, and a UI must still be able
 * to say "busy"); everything that names a run or an owner is the caller's own.
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
import { pinTestEnv } from './lifecycle-harness.helpers';

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

type Row = {
  group: string;
  held: boolean;
  holder: { runId: string; orchestration: string } | null;
  queued: Array<{ id: number; ownerId: string }>;
  policy: string | null;
};

const GROUP = 'shared-env';

describe('/api/concurrency owner scoping', () => {
  let server: http.Server;
  let tmpRoot: string;
  let baseUrl: string;
  let store: SqliteRunStore;
  // This suite mounts the API by hand rather than through the harness, so it
  // pinned only the two knobs it knew about; an ambient SAMMY_READONLY_USERS
  // (alice pinned to read) turned the owner's own withdraw into a 403.
  let restoreEnv: () => void;
  const ids: Record<string, number> = {};

  const rowFor = async (headers?: Record<string, string>): Promise<Row> => {
    const rows = (await (
      await fetch(`${baseUrl}/api/concurrency`, { headers })
    ).json()) as Row[];
    const row = rows.find(r => r.group === GROUP);
    expect(row).toBeDefined();
    return row!;
  };
  const parkedIds = async (): Promise<number[]> =>
    (await store.listPendingFires(GROUP)).map(f => f.id);

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-conc-scope-'));
    await fs.mkdir(path.join(tmpRoot, 'examples'), { recursive: true });
    for (const name of ['holder-orch', 'queued-orch']) {
      await fs.writeFile(
        path.join(tmpRoot, 'examples', `${name}.json`),
        JSON.stringify({
          name,
          concurrency: { group: GROUP, policy: 'queue' },
          phases: [{ name: 'p', code: { source: "return 'x'" } }],
        }),
        'utf8',
      );
    }
    store = new SqliteRunStore(tmpRoot);
    await store.init();
    // Alice holds the group (paused still holds); one fire parked per owner.
    await store.upsertRun({
      id: 'holder-run',
      orchestrationName: 'holder-orch',
      ownerId: 'alice',
      startedAt: Date.now() - 5_000,
      status: 'paused',
      events: [],
      concurrencyGroup: GROUP,
    });
    for (const owner of ['system', 'alice', 'bob']) {
      await store.enqueuePendingFire(GROUP, {
        orchName: 'queued-orch',
        initialInput: owner,
        ownerId: owner,
      });
    }
    for (const f of await store.listPendingFires(GROUP)) ids[f.ownerId] = f.id;

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
    restoreEnv?.();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('the owner of the holder sees it; everyone else sees only that the group is held', async () => {
    const alice = await rowFor({ 'x-sammy-user': 'alice' });
    expect(alice.held).toBe(true);
    expect(alice.holder).toMatchObject({ runId: 'holder-run', orchestration: 'holder-orch' });
    expect(alice.policy).toBe('queue');

    for (const headers of [undefined, { 'x-sammy-user': 'bob' }]) {
      const other = await rowFor(headers);
      expect(other.held).toBe(true);
      expect(other.holder).toBeNull();
      // The policy is a workspace declaration — still resolved.
      expect(other.policy).toBe('queue');
      expect(JSON.stringify(other)).not.toContain('holder-run');
    }
  });

  it('queued fires are the caller’s own — headerless means system', async () => {
    expect((await rowFor()).queued.map(q => q.ownerId)).toEqual(['system']);
    expect((await rowFor({ 'x-sammy-user': 'alice' })).queued.map(q => q.ownerId)).toEqual([
      'alice',
    ]);
    expect((await rowFor({ 'x-sammy-user': 'bob' })).queued.map(q => q.ownerId)).toEqual([
      'bob',
    ]);
  });

  it('withdraw-by-id of another owner’s fire is 404 and the fire stays parked', async () => {
    const res = await fetch(`${baseUrl}/api/concurrency/${GROUP}/queued/${ids.alice}`, {
      method: 'DELETE',
      headers: { 'x-sammy-user': 'bob' },
    });
    expect(res.status).toBe(404);
    expect(await parkedIds()).toContain(ids.alice);
    // Headerless is system, which does not own alice's fire either.
    const anon = await fetch(`${baseUrl}/api/concurrency/${GROUP}/queued/${ids.alice}`, {
      method: 'DELETE',
    });
    expect(anon.status).toBe(404);
    expect(await parkedIds()).toContain(ids.alice);
  });

  it('the owner can withdraw their own fire by id', async () => {
    const res = await fetch(`${baseUrl}/api/concurrency/${GROUP}/queued/${ids.alice}`, {
      method: 'DELETE',
      headers: { 'x-sammy-user': 'alice' },
    });
    expect(res.status).toBe(200);
    expect(await parkedIds()).not.toContain(ids.alice);
  });

  it('bulk withdraw removes only the caller’s fires', async () => {
    const res = await fetch(`${baseUrl}/api/concurrency/${GROUP}/queued`, {
      method: 'DELETE',
      headers: { 'x-sammy-user': 'bob' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ withdrawn: 1 });
    expect(await parkedIds()).toEqual([ids.system]);
  });
});
