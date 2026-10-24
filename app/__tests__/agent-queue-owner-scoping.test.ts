/**
 * /api/agent-queue is owner-scoped — the un-scoped twin of the
 * `/api/concurrency` view that was fixed for exactly this shape.
 *
 * GET mapped `agentQueueSnapshot()` straight out, so one read named the
 * `runId`, orchestration and live phase of EVERY blocked leaf dispatch in the
 * process regardless of owner. And `POST /api/agent-queue/reorder` moved a
 * waiter addressed by id alone with no ownership check — repeatable, so one
 * tenant could hold another tenant's blocked dispatch at the back of the
 * queue indefinitely. The sibling `/api/concurrency` view is owner-scoped, so
 * the agent queue was the one place that leaked the same facts.
 *
 * The scoping is resolved from the RUN each waiter names (`getRunSummary(id,
 * ownerId)`, the existing owner-404 primitive) rather than from the waiter:
 * `WaiterMeta` carries no owner and the executor layer has no owner concept.
 *
 * What stays public is deliberate, and matches `/api/concurrency`'s public
 * `held` flag: the aggregate `limit` / `inUse` / `waiting`, and each row's
 * `id`, `position`, `enqueuedAt` and `waitedMs` — so the Queue view can still
 * say "2 ahead of you, waiting 40s" for everyone.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import connect from 'connect';
import { mountSammyApi } from '../sammy-pack-api';
import { SqliteRunStore } from '../src/server/db';
import { agentSlots, type Release } from '../src/llm/concurrency';
import { pinTestEnv } from './lifecycle-harness.helpers';

jest.setTimeout(45_000);

const ALICE = 'alice';
const BOB = 'bob';

type QueueRow = {
  id: string;
  runId: string | null;
  orchestrationName: string | null;
  phaseName: string | null;
  position: number;
  enqueuedAt: number;
  waitedMs: number;
  blockedBy: string;
};
type QueueBody = {
  limit: number;
  inUse: number;
  waiting: number;
  queued: QueueRow[];
};

describe('/api/agent-queue owner scoping', () => {
  let server: http.Server;
  let tmpRoot: string;
  let baseUrl: string;
  let store: SqliteRunStore;
  let restoreEnv: () => void;
  let prevLimit: number;
  const released: Release[] = [];

  const queue = async (owner?: string): Promise<QueueBody> =>
    (await (
      await fetch(`${baseUrl}/api/agent-queue`, {
        headers: owner ? { 'x-sammy-user': owner } : {},
      })
    ).json()) as QueueBody;

  const reorder = async (
    owner: string | undefined,
    body: Record<string, unknown>,
  ): Promise<{ status: number; text: string }> => {
    const res = await fetch(`${baseUrl}/api/agent-queue/reorder`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(owner ? { 'x-sammy-user': owner } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-agentq-scope-'));
    await fs.mkdir(path.join(tmpRoot, 'examples'), { recursive: true });
    store = new SqliteRunStore(tmpRoot);
    await store.init();
    // Two runs, two owners. The names are what the leak exposed.
    await store.upsertRun({
      id: 'alice-run',
      orchestrationName: 'alice-payroll-pipeline',
      startedAt: Date.now(),
      status: 'running',
      events: [],
      ownerId: ALICE,
    });
    await store.upsertRun({
      id: 'bob-run',
      orchestrationName: 'bob-pipeline',
      startedAt: Date.now(),
      status: 'running',
      events: [],
      ownerId: BOB,
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

    // Saturate the one global slot, then queue three dispatches with exactly
    // the meta `runAgentPhase` passes — one per owner, plus an anonymous one
    // (an in-browser / CLI dispatch leaves `runId` undefined).
    prevLimit = agentSlots.limit;
    agentSlots.setLimit(1);
    released.push(await agentSlots.acquire({ runId: 'holder' }));
    // Three dispatches that will NOT be granted while the holder keeps the
    // slot — their acquires stay pending, which is what puts them in the
    // queue. Each resolves only at teardown, when the holder is released.
    const pending = [
      agentSlots.acquire({
        runId: 'alice-run',
        orchestrationName: 'alice-payroll-pipeline',
        phaseName: 'alice-secret-phase',
      }),
      agentSlots.acquire({
        runId: 'bob-run',
        orchestrationName: 'bob-pipeline',
        phaseName: 'bob-phase',
      }),
      agentSlots.acquire(),
    ];
    for (const p of pending) p.then(r => released.push(r), () => {});
  });

  afterAll(async () => {
    agentSlots.setLimit(prevLimit);
    for (const r of released) r();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await store.close();
    restoreEnv?.();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('shows alice her own row in full', async () => {
    const body = await queue(ALICE);
    const mine = body.queued.filter(q => q.runId !== null);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      runId: 'alice-run',
      orchestrationName: 'alice-payroll-pipeline',
      phaseName: 'alice-secret-phase',
      blockedBy: 'agent-concurrency-cap',
    });
  });

  it('names no other tenant\'s run to bob, or to an anonymous caller', async () => {
    for (const owner of [BOB, undefined]) {
      const res = await fetch(`${baseUrl}/api/agent-queue`, {
        headers: owner ? { 'x-sammy-user': owner } : {},
      });
      const text = await res.text();
      expect(text).not.toContain('alice-run');
      expect(text).not.toContain('alice-payroll-pipeline');
      expect(text).not.toContain('alice-secret-phase');
    }
  });

  it('keeps the positional truth and the aggregates public', async () => {
    const body = await queue(BOB);
    expect(body.limit).toBe(1);
    expect(body.waiting).toBe(3);
    // Every row is still THERE — only its run attribution is withheld — so a
    // UI can say how many are ahead and how long they have waited.
    expect(body.queued).toHaveLength(3);
    expect(body.queued.map(q => q.position)).toEqual([0, 1, 2]);
    for (const q of body.queued) {
      expect(typeof q.enqueuedAt).toBe('number');
      expect(q.waitedMs).toBeGreaterThanOrEqual(0);
    }
    // Bob's own row keeps its detail.
    expect(body.queued.filter(q => q.runId === 'bob-run')).toHaveLength(1);
  });

  it('404s a reorder of another tenant\'s waiter and leaves the order intact', async () => {
    const before = (await queue(ALICE)).queued;
    const aliceWaiter = before.find(q => q.runId === 'alice-run')!;
    const r = await reorder(BOB, { id: aliceWaiter.id, toIndex: 99 });
    expect(r.status).toBe(404);
    // Not an existence oracle: the same wording as a waiter that drained.
    expect(r.text).toContain('no longer waiting');
    const after = (await queue(ALICE)).queued;
    expect(after.map(q => q.id)).toEqual(before.map(q => q.id));
  });

  it('404s a reorder of an ANONYMOUS waiter for everyone', async () => {
    // A bare `acquire()` belongs to nobody, so it is reorderable by nobody —
    // previously it was reorderable by anyone. It is the one row that names no
    // run in EITHER owner's view (each owner sees the other's row nulled too).
    const named = new Set(
      [...(await queue(ALICE)).queued, ...(await queue(BOB)).queued]
        .filter(q => q.runId !== null)
        .map(q => q.id),
    );
    const anon = (await queue(ALICE)).queued.find(q => !named.has(q.id))!;
    expect(anon).toBeDefined();
    for (const owner of [ALICE, BOB, undefined]) {
      expect((await reorder(owner, { id: anon.id, dir: 'down' })).status).toBe(404);
    }
  });

  it('still lets a caller reorder their OWN waiter', async () => {
    const mine = (await queue(BOB)).queued.find(q => q.runId === 'bob-run')!;
    const r = await reorder(BOB, { id: mine.id, toIndex: 0 });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text) as QueueBody;
    expect(body.queued[0].id).toBe(mine.id);
    // The post-reorder body is the same view, so it is scoped the same way.
    expect(r.text).not.toContain('alice-payroll-pipeline');
  });
});
