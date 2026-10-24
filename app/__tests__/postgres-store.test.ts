/**
 * PostgresRunStore — the RunStore contract against a real Postgres.
 *
 * Skipped unless TEST_DATABASE_URL points at a throwaway Postgres
 * database (the suite creates + drops its own tables). Run it with:
 *
 *   TEST_DATABASE_URL=postgres://localhost/sammy_test npx jest postgres-store
 *
 * The SQLite store is covered unconditionally by db.test.ts; this
 * suite proves the Postgres backend honors the same contract.
 */

import { PostgresRunStore } from '../src/server/postgres-store';
import { describeRunStoreContract } from './run-store-contract.helpers';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('PostgresRunStore', () => {
  let store: PostgresRunStore;

  beforeEach(async () => {
    store = new PostgresRunStore(url as string);
    await store.init();
    // Start each test from a clean slate.
    for (const r of await store.listRuns(1000)) {
      await store.deleteRun(r.id);
    }
  });

  afterEach(async () => {
    await store.close();
  });

  it('upsert + get round-trips header + events', async () => {
    await store.upsertRun({
      id: 'pg-1',
      orchestrationName: 'ticket-to-pr',
      startedAt: 1000,
      endedAt: 2000,
      status: 'done',
      orchestrationSnapshot: { name: 'ticket-to-pr', phases: [] },
      initialInput: 'JIRA-42',
      events: [
        { type: 'run-start', ts: 1001 },
        { type: 'phase-end', phaseName: 'spec', output: 'o', ts: 1100 },
        { type: 'run-end', ts: 1999 },
      ],
    });
    const got = await store.getRun('pg-1');
    expect(got?.status).toBe('done');
    expect(got?.startedAt).toBe(1000);
    expect(got?.events.map(e => e.type)).toEqual([
      'run-start',
      'phase-end',
      'run-end',
    ]);
    expect(got?.orchestrationSnapshot).toEqual({
      name: 'ticket-to-pr',
      phases: [],
    });
  });

  it('appendEvent assigns increasing seq', async () => {
    await store.upsertRun({
      id: 'pg-2',
      orchestrationName: 'x',
      startedAt: 1,
      status: 'running',
      events: [{ type: 'seed' }],
    });
    await store.appendEvent('pg-2', { type: 'a' });
    await store.appendEvent('pg-2', { type: 'b' });
    const got = await store.getRun('pg-2');
    expect(got?.events.map(e => e.type)).toEqual(['seed', 'a', 'b']);
  });

  it('updateRunStatus patches checkpoint columns', async () => {
    await store.upsertRun({
      id: 'pg-3',
      orchestrationName: 'x',
      startedAt: 1,
      status: 'running',
      events: [],
    });
    await store.updateRunStatus('pg-3', {
      status: 'paused',
      pausedFor: 'plan',
      completedLeaves: ['spec'],
      stateJson: { leafOutputs: { spec: 'out' } },
    });
    const got = await store.getRun('pg-3');
    expect(got?.status).toBe('paused');
    expect(got?.pausedFor).toBe('plan');
    expect(got?.completedLeaves).toEqual(['spec']);
    expect(got?.stateJson).toEqual({ leafOutputs: { spec: 'out' } });
  });

  it('listPausedRuns returns every paused run with stateJson (sweeper view)', async () => {
    await store.upsertRun({
      id: 'pg-paused-wait',
      orchestrationName: 'x',
      startedAt: 1,
      status: 'running',
      events: [],
    });
    await store.updateRunStatus('pg-paused-wait', {
      status: 'paused',
      pausedFor: 'cool-down',
      stateJson: {
        leafOutputs: {},
        pendingWait: { replayKey: 'cool-down', kind: 'timer', resumeAt: 99 },
      },
    });
    await store.upsertRun({
      id: 'pg-done',
      orchestrationName: 'x',
      startedAt: 2,
      status: 'done',
      events: [],
    });
    const paused = await store.listPausedRuns();
    const ids = paused.map(h => h.id);
    expect(ids).toContain('pg-paused-wait');
    expect(ids).not.toContain('pg-done');
    const parked = paused.find(h => h.id === 'pg-paused-wait');
    // stateJson must ride the header — the wait sweeper reads
    // pendingWait off it without hydrating events.
    expect(
      (parked?.stateJson as { pendingWait?: { kind?: string } })?.pendingWait
        ?.kind,
    ).toBe('timer');
  });

  it('costSummary sums phase-end costUsd', async () => {
    const now = Date.now();
    await store.upsertRun({
      id: 'pg-cost',
      orchestrationName: 'x',
      startedAt: now,
      status: 'done',
      events: [
        { type: 'phase-end', costUsd: 1.5, ts: now },
        { type: 'phase-end', costUsd: 0.5, ts: now },
      ],
    });
    const summary = await store.costSummary();
    expect(summary.todayUsd).toBeCloseTo(2);
    expect(summary.monthUsd).toBeCloseTo(2);
  });

  it('markOrphanedRunsAsInterrupted reclaims a run whose lease has expired', async () => {
    await store.upsertRun({
      id: 'pg-orphan',
      orchestrationName: 'x',
      startedAt: 1,
      status: 'running',
      events: [{ type: 'run-start' }],
    });
    // Fresh lease (now + TTL); scan past it to simulate a dead owner — from a
    // PEER handle, since a store never reclaims its own instance's runs.
    const peer = new PostgresRunStore(url as string, { instanceId: 'pg-peer' });
    await peer.init();
    try {
      const result = await peer.markOrphanedRunsAsInterrupted(
        Date.now() + 10 * 60_000,
      );
      expect(result.ids).toContain('pg-orphan');
    } finally {
      await peer.close();
    }
    expect((await store.getRun('pg-orphan'))?.status).toBe('interrupted');
  });

  it('markOrphanedRunsAsInterrupted leaves a run with a live lease alone', async () => {
    await store.upsertRun({
      id: 'pg-live',
      orchestrationName: 'x',
      startedAt: 1,
      status: 'running',
      events: [{ type: 'run-start' }],
    });
    // Default `now`: the fresh lease is still in the future -> not reclaimed.
    const result = await store.markOrphanedRunsAsInterrupted();
    expect(result.ids).not.toContain('pg-live');
    expect((await store.getRun('pg-live'))?.status).toBe('running');
  });

  it('fences a non-owner appendEvent, and unfences after reclaim + resume', async () => {
    // Two PostgresRunStores on one DB with distinct instanceIds = two processes.
    const a = new PostgresRunStore(url as string, { instanceId: 'pg-A' });
    await a.init();
    const b = new PostgresRunStore(url as string, { instanceId: 'pg-B' });
    await b.init();
    try {
      await a.upsertRun({
        id: 'pg-fence', orchestrationName: 'x', startedAt: 1, status: 'running', events: [],
      });
      // Owner writes; peer is fenced while running.
      await a.appendEvent('pg-fence', { type: 'phase-start' });
      await expect(b.appendEvent('pg-fence', { type: 'phase-start' })).rejects.toThrow(
        /lease for run "pg-fence"/,
      );
      // B reclaims the expired-lease run and resumes (claims the lease)...
      const reclaimed = await b.markOrphanedRunsAsInterrupted(Date.now() + 10 * 60_000);
      expect(reclaimed.ids).toContain('pg-fence');
      await b.updateRunStatus('pg-fence', { status: 'running' });
      // ...now B writes and the old owner A is fenced.
      await b.appendEvent('pg-fence', { type: 'phase-start' });
      await expect(a.appendEvent('pg-fence', { type: 'phase-start' })).rejects.toThrow(
        /lease for run "pg-fence"/,
      );
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('deleteRun cascades to events', async () => {
    await store.upsertRun({
      id: 'pg-del',
      orchestrationName: 'x',
      startedAt: 1,
      status: 'done',
      events: [{ type: 'a' }],
    });
    expect(await store.deleteRun('pg-del')).toBe(true);
    expect(await store.getRun('pg-del')).toBeNull();
  });

  describe('trigger deliveries (P0 durable ingress)', () => {
    const base = {
      kind: 'webhook',
      name: 'deploy',
      orchestrationName: 'ticket-to-pr',
      keySource: 'header' as const,
    };

    beforeEach(async () => {
      for (const d of await store.listDeliveries(1000)) {
        await store.updateDelivery(d.id, {}); // no-op; ensure method exists
      }
      // Clean slate: deliveries aren't cascaded by deleteRun, wipe directly.
      const all = await store.listDeliveries(1000);
      // No bulk-delete API; rely on unique ids per test + key namespacing.
      void all;
    });

    it('recordDelivery + findDeliveriesByKey round-trip, windows auto keys', async () => {
      const now = Date.now();
      await store.recordDelivery({
        ...base,
        keySource: 'auto',
        id: `pg-old-${now}`,
        idempotencyKey: `auto:pgk-${now}`,
        receivedAt: now - 120_000,
        body: 'old',
      });
      await store.recordDelivery({
        ...base,
        keySource: 'auto',
        id: `pg-recent-${now}`,
        idempotencyKey: `auto:pgk-${now}`,
        receivedAt: now,
        body: 'recent',
      });
      expect(
        (await store.findDeliveriesByKey(`auto:pgk-${now}`)).length,
      ).toBe(2);
      const windowed = await store.findDeliveriesByKey(`auto:pgk-${now}`, {
        sinceMs: 60_000,
      });
      expect(windowed.map(d => d.id)).toEqual([`pg-recent-${now}`]);
      expect(windowed[0].status).toBe('accepted');
      expect(windowed[0].ownerId).toBe('system');
    });

    it('updateDelivery patches status / runId / firedAt / detail', async () => {
      const id = `pg-upd-${Date.now()}`;
      await store.recordDelivery({
        ...base,
        id,
        idempotencyKey: id,
        receivedAt: 1,
      });
      await store.updateDelivery(id, {
        status: 'fired',
        runId: 'run-pg',
        firedAt: 4242,
      });
      let got = (await store.findDeliveriesByKey(id))[0];
      expect(got.status).toBe('fired');
      expect(got.runId).toBe('run-pg');
      expect(got.firedAt).toBe(4242);
      await store.updateDelivery(id, { status: 'rejected', detail: 'nope' });
      got = (await store.findDeliveriesByKey(id))[0];
      expect(got.status).toBe('rejected');
      expect(got.detail).toBe('nope');
      expect(got.runId).toBe('run-pg');
    });

    it('rejects unknown delivery status', async () => {
      await expect(
        store.recordDelivery({
          ...base,
          id: `pg-bad-${Date.now()}`,
          idempotencyKey: `pg-bad-${Date.now()}`,
          status: 'fake' as never,
          receivedAt: 1,
        }),
      ).rejects.toThrow(/Invalid delivery status/);
    });
  });

  describe('delivery queue — FOR UPDATE SKIP LOCKED (P1)', () => {
    // Postgres data persists across tests + runs (unlike the fresh-DB
    // SQLite suite). Clear every claimable delivery first so claim-order
    // assertions are deterministic.
    beforeEach(async () => {
      for (;;) {
        const d = await store.claimNextDelivery(1e15);
        if (!d) break;
        await store.rejectDelivery(d.id, 'cleared', 1e15, d.claimToken);
      }
    });

    async function enqueue(id: string, over: Record<string, unknown> = {}) {
      await store.recordDelivery({
        kind: 'webhook',
        name: 'q',
        orchestrationName: 'o',
        keySource: 'header',
        status: 'pending',
        id,
        idempotencyKey: id,
        receivedAt: 1,
        availableAt: 1,
        ...over,
      });
    }
    async function get(id: string) {
      return (await store.listDeliveries(1000)).find(d => d.id === id);
    }

    it('claims oldest claimable, respects available_at, transitions', async () => {
      const tag = `pg-q-${Date.now()}`;
      await enqueue(`${tag}-old`, { receivedAt: 1 });
      await enqueue(`${tag}-new`, { receivedAt: 9 });
      await enqueue(`${tag}-future`, { receivedAt: 2, availableAt: 999999 });

      const c1 = await store.claimNextDelivery(1000);
      expect(c1?.id).toBe(`${tag}-old`);
      expect(c1?.status).toBe('claimed');
      expect(c1?.attempts).toBe(1);

      await store.completeDelivery(`${tag}-old`, 'run-1', 2000, c1!.claimToken);
      expect((await get(`${tag}-old`))?.status).toBe('fired');
      expect((await get(`${tag}-old`))?.runId).toBe('run-1');

      const c2 = await store.claimNextDelivery(1000);
      expect(c2?.id).toBe(`${tag}-new`); // future one is skipped
      await store.failDelivery(`${tag}-new`, {
        error: 'transient',
        now: 1000,
        retryAt: 1500,
        claimToken: c2!.claimToken,
      });
      expect((await get(`${tag}-new`))?.status).toBe('pending');
      expect((await get(`${tag}-new`))?.availableAt).toBe(1500);

      // Nothing else claimable at t=1000 (future not due, new backed off).
      expect(await store.claimNextDelivery(1000)).toBeNull();
    });

    it('concurrent claims never double-claim (SKIP LOCKED)', async () => {
      const tag = `pg-cc-${Date.now()}`;
      for (let i = 0; i < 8; i += 1) await enqueue(`${tag}-${i}`);
      // Fire MORE claims than rows, all at once: each row claimed by exactly
      // one caller, the surplus callers get null. No double-claim.
      const claimed = await Promise.all(
        Array.from({ length: 12 }, () => store.claimNextDelivery(1000)),
      );
      const ids = claimed.filter(Boolean).map(d => d!.id);
      expect(new Set(ids).size).toBe(ids.length); // no duplicates
      expect(ids.length).toBe(8); // exactly our eight, each once
      expect(ids.every(id => id.startsWith(tag))).toBe(true);
    });

    it('reclaimStaleDeliveries requeues orphaned claimed rows', async () => {
      const tag = `pg-rc-${Date.now()}`;
      await enqueue(`${tag}-stuck`);
      await store.claimNextDelivery(1000); // claimed_at = 1000
      const r = await store.reclaimStaleDeliveries(5000, 10000);
      expect(r.ids).toContain(`${tag}-stuck`);
      expect((await get(`${tag}-stuck`))?.status).toBe('pending');
    });

    it('honors a per-orch in-flight cap (correlated SKIP LOCKED)', async () => {
      const tag = `pg-cap-${Date.now()}`;
      await enqueue(`${tag}-a1`, { orchestrationName: `${tag}-A`, receivedAt: 1 });
      await enqueue(`${tag}-a2`, { orchestrationName: `${tag}-A`, receivedAt: 2 });
      await enqueue(`${tag}-b1`, { orchestrationName: `${tag}-B`, receivedAt: 3 });
      const c1 = await store.claimNextDelivery(100, { maxInFlightPerOrch: 1 });
      expect(c1?.id).toBe(`${tag}-a1`);
      const c2 = await store.claimNextDelivery(100, { maxInFlightPerOrch: 1 });
      expect(c2?.id).toBe(`${tag}-b1`); // a2 skipped — A at cap
      expect(
        await store.claimNextDelivery(100, { maxInFlightPerOrch: 1 }),
      ).toBeNull();
    });

    it('replayDelivery re-drives a dead-lettered delivery', async () => {
      const tag = `pg-replay-${Date.now()}`;
      await enqueue(`${tag}-d`);
      const f_5585 = await store.claimNextDelivery(1);
      await store.failDelivery(`${tag}-d`, { error: 'boom', now: 2, claimToken: f_5585!.claimToken });
      expect((await get(`${tag}-d`))?.status).toBe('failed');
      expect(await store.replayDelivery(`${tag}-d`, 100)).toBe(true);
      const got = await get(`${tag}-d`);
      expect(got?.status).toBe('pending');
      expect(got?.attempts).toBe(0);
      expect(await store.replayDelivery(`${tag}-d`, 100)).toBe(false); // now pending
    });
  });

  describe('Postgres-specific SQL where the two dialects diverge', () => {
    /**
     * These methods' SQL is written TWICE — once per backend — and the two
     * dialects diverge exactly where it matters: a partial unique index with
     * a status predicate, an upsert whose DO UPDATE carries a WHERE, a
     * fenced UPDATE's rowCount. All of it typechecks identically against
     * either store, so a mistake here is invisible until it runs on Postgres.
     * The SQLite twins of these cases live in db.test.ts; this is the only
     * place the Postgres SQL is actually executed.
     */
    /** Unique per test: Postgres data persists across tests and runs here. */
    const tagged = () => `pg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const row = (
      id: string,
      key: string,
      over: Record<string, unknown> = {},
    ) => ({
      id,
      kind: 'webhook' as const,
      name: 'n',
      orchestrationName: 'o',
      idempotencyKey: key,
      keySource: 'header' as const,
      status: 'pending' as const,
      body: 'b',
      receivedAt: 1,
      availableAt: 1,
      ...over,
    });
    const get = async (id: string) =>
      (await store.listDeliveries(1000)).find(d => d.id === id);

    describe('durable group locks (ON CONFLICT … DO UPDATE … WHERE)', () => {
      it('a held lock cannot be taken by another holder', async () => {
        const g = tagged();
        expect(await store.acquireGroupLock(g, 'proc-a', 10_000)).toBe(true);
        expect(await store.acquireGroupLock(g, 'proc-b', 10_000)).toBe(false);
      });

      it('re-acquiring as the SAME holder also respects the hold', async () => {
        // The upsert's WHERE is on expiry, not identity, so a holder
        // refreshing its own unexpired lock is refused too. Worth pinning:
        // it means the lock is not accidentally re-entrant.
        const g = tagged();
        expect(await store.acquireGroupLock(g, 'proc-a', 10_000)).toBe(true);
        expect(await store.acquireGroupLock(g, 'proc-a', 10_000)).toBe(false);
      });

      it('an EXPIRED lock is reclaimable — a crashed holder cannot wedge it', async () => {
        const g = tagged();
        expect(await store.acquireGroupLock(g, 'dead', 50, 1_000)).toBe(true);
        expect(await store.acquireGroupLock(g, 'live', 50, 1_040)).toBe(false);
        expect(await store.acquireGroupLock(g, 'live', 50, 1_100)).toBe(true);
      });

      it('only the holder can release', async () => {
        const g = tagged();
        expect(await store.acquireGroupLock(g, 'owner', 10_000)).toBe(true);
        await store.releaseGroupLock(g, 'impostor');
        expect(await store.acquireGroupLock(g, 'third', 10_000)).toBe(false);
        await store.releaseGroupLock(g, 'owner');
        expect(await store.acquireGroupLock(g, 'third', 10_000)).toBe(true);
      });

      it('different groups never block each other', async () => {
        const a = tagged();
        const b = tagged();
        expect(await store.acquireGroupLock(a, 'p', 10_000)).toBe(true);
        expect(await store.acquireGroupLock(b, 'p', 10_000)).toBe(true);
      });
    });

    describe('the PARTIAL unique index on header keys', () => {
      it('refuses a second LIVE row for one key, without throwing', async () => {
        const key = tagged();
        expect(await store.recordDelivery(row(`${key}-1`, key))).toBe(true);
        expect(await store.recordDelivery(row(`${key}-2`, key))).toBe(false);
        expect(await get(`${key}-2`)).toBeUndefined();
      });

      it('a REFUSED row releases the key (the status predicate)', async () => {
        // This is the half that only exists in the index predicate, so it
        // can only be verified by executing it.
        const key = tagged();
        expect(
          await store.recordDelivery(row(`${key}-r`, key, { status: 'rejected' })),
        ).toBe(true);
        expect(await store.recordDelivery(row(`${key}-retry`, key))).toBe(true);
      });

      it('a row that BECOMES refused releases the key', async () => {
        const key = tagged();
        await store.recordDelivery(row(`${key}-1`, key));
        const c = await store.claimNextDelivery(1e15);
        // The claim loop may hand back an unrelated leftover; settle until
        // ours is the one claimed.
        let claimed = c;
        while (claimed && claimed.id !== `${key}-1`) {
          await store.rejectDelivery(claimed.id, 'cleared', 1e15, claimed.claimToken);
          claimed = await store.claimNextDelivery(1e15);
        }
        expect(claimed!.id).toBe(`${key}-1`);
        expect(
          await store.rejectDelivery(`${key}-1`, 'budget', 2, claimed!.claimToken),
        ).toBe(true);
        expect(await store.recordDelivery(row(`${key}-2`, key))).toBe(true);
      });

      it('the same key FANS OUT to one row per orchestration', async () => {
        const key = tagged();
        for (const orch of ['a', 'b', 'c']) {
          expect(
            await store.recordDelivery(
              row(`${key}-${orch}`, key, { orchestrationName: orch }),
            ),
          ).toBe(true);
        }
        expect(
          await store.recordDelivery(row(`${key}-dup`, key, { orchestrationName: 'a' })),
        ).toBe(false);
      });

      it('AUTO keys may repeat — the constraint must not catch them', async () => {
        const key = tagged();
        const auto = (id: string) => row(id, key, { keySource: 'auto' as const });
        expect(await store.recordDelivery(auto(`${key}-1`))).toBe(true);
        expect(await store.recordDelivery(auto(`${key}-2`))).toBe(true);
      });

      it('findDeliveriesByKey({ excludeRefused }) matches the predicate', async () => {
        const key = tagged();
        await store.recordDelivery(row(`${key}-ok`, key));
        await store.recordDelivery(
          row(`${key}-no`, key, { status: 'rejected', orchestrationName: 'other' }),
        );
        expect((await store.findDeliveriesByKey(key)).map(d => d.id).sort()).toEqual(
          [`${key}-no`, `${key}-ok`].sort(),
        );
        expect(
          (await store.findDeliveriesByKey(key, { excludeRefused: true })).map(d => d.id),
        ).toEqual([`${key}-ok`]);
      });
    });

    describe('claim fencing (rowCount on a guarded UPDATE)', () => {
      it('a stale claim token cannot settle a re-claimed delivery', async () => {
        const key = tagged();
        await store.recordDelivery(row(`${key}-d`, key));
        let a = await store.claimNextDelivery(1e15);
        while (a && a.id !== `${key}-d`) {
          await store.rejectDelivery(a.id, 'cleared', 1e15, a.claimToken);
          a = await store.claimNextDelivery(1e15);
        }
        expect(a!.id).toBe(`${key}-d`);

        // Reclaim + re-claim, as the sweeper plus another worker would.
        // NOTE the clock: claiming with now=1e15 (this suite's idiom for
        // "claim whatever is available") stamps claimed_at at 1e15, so the
        // reclaim cutoff has to be past that. A wall-clock `Date.now()` here
        // is ~1.7e12 and silently reclaims nothing.
        await store.reclaimStaleDeliveries(0, 1e15 + 1);
        let b = await store.claimNextDelivery(1e15);
        while (b && b.id !== `${key}-d`) {
          await store.rejectDelivery(b.id, 'cleared', 1e15, b.claimToken);
          b = await store.claimNextDelivery(1e15);
        }
        expect(b!.claimToken).toBeGreaterThan(a!.claimToken);

        expect(await store.completeDelivery(`${key}-d`, 'run-B', 3, b!.claimToken)).toBe(
          true,
        );
        // The stale owner's write must be refused, not applied.
        expect(await store.completeDelivery(`${key}-d`, 'run-A', 4, a!.claimToken)).toBe(
          false,
        );
        const got = await get(`${key}-d`);
        expect(got?.runId).toBe('run-B');
      });

      it('a replay resets attempts but NOT the claim token', async () => {
        const key = tagged();
        await store.recordDelivery(row(`${key}-d`, key));
        let c = await store.claimNextDelivery(1e15);
        while (c && c.id !== `${key}-d`) {
          await store.rejectDelivery(c.id, 'cleared', 1e15, c.claimToken);
          c = await store.claimNextDelivery(1e15);
        }
        const firstToken = c!.claimToken;
        await store.failDelivery(`${key}-d`, {
          error: 'boom',
          now: 2,
          claimToken: firstToken,
        });
        expect(await store.replayDelivery(`${key}-d`, 3)).toBe(true);
        const after = await get(`${key}-d`);
        expect(after?.attempts).toBe(0);
        // A reusable fence is no fence.
        expect(after?.claimToken).toBe(firstToken);
      });
    });

    describe('deferDelivery / prune / polling seed / duplicate counter', () => {
      it('deferDelivery parks a claimed row, fenced', async () => {
        const key = tagged();
        await store.recordDelivery(row(`${key}-d`, key));
        let c = await store.claimNextDelivery(1e15);
        while (c && c.id !== `${key}-d`) {
          await store.rejectDelivery(c.id, 'cleared', 1e15, c.claimToken);
          c = await store.claimNextDelivery(1e15);
        }
        expect(
          await store.deferDelivery(`${key}-d`, 'group busy', 2, c!.claimToken),
        ).toBe(true);
        const got = await get(`${key}-d`);
        expect(got?.status).toBe('deferred');
        expect(got?.detail).toBe('group busy');
        // A stale token cannot defer.
        expect(await store.deferDelivery(`${key}-d`, 'again', 3, c!.claimToken)).toBe(
          false,
        );
      });

      it('pruneTerminalDeliveries removes terminal rows and spares live ones', async () => {
        const key = tagged();
        await store.recordDelivery(
          row(`${key}-old-fired`, `${key}-a`, { status: 'fired', receivedAt: 1_000 }),
        );
        await store.recordDelivery(
          row(`${key}-old-pending`, `${key}-b`, { status: 'pending', receivedAt: 1_000 }),
        );
        await store.recordDelivery(
          row(`${key}-fresh`, `${key}-c`, { status: 'fired', receivedAt: 9_000 }),
        );

        // Asserted on presence, not on the returned count: this database
        // carries rows from every other case in the suite.
        await store.pruneTerminalDeliveries(1_000, 5_000); // cutoff 4000
        expect(await get(`${key}-old-fired`)).toBeUndefined();
        expect(await get(`${key}-old-pending`)).toBeDefined(); // live work spared
        expect(await get(`${key}-fresh`)).toBeDefined();
      });

      it('findLastPollingDelivery is scoped to source AND orchestration', async () => {
        const src = `https://example.com/${tagged()}`;
        await store.recordDelivery(
          row(`${src}-a`, tagged(), {
            kind: 'polling',
            name: src,
            orchestrationName: 'orch-a',
            body: 'body-a',
            receivedAt: 10,
          }),
        );
        await store.recordDelivery(
          row(`${src}-b`, tagged(), {
            kind: 'polling',
            name: src,
            orchestrationName: 'orch-b',
            body: 'body-b',
            receivedAt: 20,
          }),
        );
        // Each orchestration sees its OWN watermark, not the newest row for
        // that URL — inheriting another's is how a new orch never fired.
        expect((await store.findLastPollingDelivery(src, 'orch-a'))?.body).toBe('body-a');
        expect((await store.findLastPollingDelivery(src, 'orch-b'))?.body).toBe('body-b');
        expect(await store.findLastPollingDelivery(src, 'orch-c')).toBeNull();
      });

      it('the duplicate counter increments and sums', async () => {
        const key = tagged();
        await store.recordDelivery(row(`${key}-d`, key));
        expect((await get(`${key}-d`))?.duplicateCount).toBe(0);
        const before = await store.sumDuplicatesSuppressed();
        await store.noteDuplicateSuppressed(`${key}-d`);
        await store.noteDuplicateSuppressed(`${key}-d`);
        expect((await get(`${key}-d`))?.duplicateCount).toBe(2);
        expect(await store.sumDuplicatesSuppressed()).toBe(before + 2);
      });
    });
  });
});

// The SHARED conformance suite — the SAME assertions db.test.ts runs against
// SQLite. This is what stops the two hand-written SQL implementations from
// diverging on a contract neither suite happens to cover.
if (url) {
  describeRunStoreContract('PostgresRunStore', {
    make: async () => {
      const s = new PostgresRunStore(url);
      await s.init();
      for (const r of await s.listRuns(1000)) await s.deleteRun(r.id);
      // The test database persists across runs; the contract promises an
      // EMPTY store, so the delivery queue has to be cleared as well — a
      // leftover claimable row is otherwise what the next claim returns.
      await (s as unknown as { pool: { query: (q: string) => Promise<unknown> } }).pool.query(
        'DELETE FROM trigger_deliveries',
      );
      return s;
    },
    dispose: async st => {
      await st.close();
    },
  });
}
