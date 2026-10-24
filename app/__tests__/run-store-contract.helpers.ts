/**
 * A SHARED RunStore conformance suite, run against every backend.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * `db.ts` (SQLite) and `postgres-store.ts` (Postgres) implement the same
 * 44-method interface with ~78 hand-written SQL statements each, and they are
 * tested by two independently hand-written files. That is parity by
 * CONVENTION: nothing makes the two suites assert the same things, and in
 * practice they did not — Postgres had no coverage of `pruneTerminalRuns` or
 * `renewLease` at all, and both are exactly where reliability lives.
 *
 * The SQL diverges where it matters (a partial unique index with a status
 * predicate, an upsert whose DO UPDATE carries a WHERE, rowCount from a
 * fenced UPDATE), and all of it typechecks identically against either store —
 * so a Postgres-only mistake is invisible until it runs there.
 *
 * This is the seam that fixes the class: one body of assertions, parameterised
 * over a store factory, called from both backends' suites. It starts with the
 * owner-scoping contract because that is the newest and the one whose absence
 * was a security boundary, and should GROW to absorb the duplicated
 * assertions rather than having new contracts written twice again.
 *
 * ── Note on file placement ───────────────────────────────────────────────
 * The jest preset's default testMatch treats every `.ts` under `__tests__/`
 * as a suite, so this file carries one self-test — same convention as
 * `lifecycle-harness.helpers.ts`.
 */

import path from 'node:path';
import type pg from 'pg';
import { SqliteRunStore } from '../src/server/db';
import { PostgresRunStore } from '../src/server/postgres-store';
import { LeaseLostError, type RunStore } from '../src/server/run-store';

export type StoreFactory = {
  /** Fresh, initialised, empty store. */
  make: () => Promise<RunStore>;
  /** Release it (close handles / drop the pool). */
  dispose: (store: RunStore) => Promise<void>;
};

const DAY = 86_400_000;

/** A SECOND handle on `store`'s backing database under its own lease identity
 *  — "another process". Derived from the store's own backend so neither
 *  suite needs new factory wiring, and it never wipes anything: the lease
 *  contracts (fencing, reclaim) are only expressible with two processes on
 *  one store. Callers `close()` it themselves. */
async function peerOf(store: RunStore, instanceId: string): Promise<RunStore> {
  const peer =
    store.backend === 'sqlite'
      ? new SqliteRunStore(path.dirname(store.filePath as string), { instanceId })
      : new PostgresRunStore(process.env.TEST_DATABASE_URL as string, {
          instanceId,
        });
  await peer.init();
  return peer;
}

/** Run `after` each time a statement whose SQL matches `re` COMPLETES while
 *  `fn` runs — the seam for both counting statements and interposing a peer
 *  write between two of them. Necessarily backend-aware (each driver has its
 *  own hook point), which is why it lives here once rather than in each
 *  suite. The SQLite tap is synchronous: better-sqlite3 runs the statement
 *  and the hook back to back on the same tick, so a hook that writes through
 *  a SqliteRunStore peer (whose body is synchronous) lands before the
 *  store's next statement. The Postgres tap awaits the hook before the
 *  statement's result is handed back. Restores every wrapper after. */
async function tapStatements(
  store: RunStore,
  re: RegExp,
  after: () => void | Promise<void>,
  fn: () => Promise<void>,
): Promise<void> {
  const undo: Array<() => void> = [];
  if (store.backend === 'sqlite') {
    type Stmt = Record<'run' | 'all' | 'get', (...a: unknown[]) => unknown>;
    const db = (store as unknown as { db: { prepare: (sql: string) => Stmt } }).db;
    const prepare = db.prepare;
    db.prepare = (sql: string): Stmt => {
      const stmt = prepare.call(db, sql);
      if (re.test(sql)) {
        for (const m of ['run', 'all', 'get'] as const) {
          const orig = stmt[m].bind(stmt);
          stmt[m] = (...a: unknown[]) => {
            const out = orig(...a);
            void after();
            return out;
          };
        }
      }
      return stmt;
    };
    undo.push(() => {
      db.prepare = prepare;
    });
  } else {
    // Every statement the store runs in a transaction goes through a pooled
    // client's `query`; wrap each client the pool hands out.
    const pool = (store as unknown as { pool: pg.Pool }).pool;
    const connect = pool.connect as unknown as () => Promise<pg.PoolClient>;
    const wrapped = new Map<pg.PoolClient, pg.PoolClient['query']>();
    pool.connect = (async () => {
      const client = await connect.call(pool);
      if (!wrapped.has(client)) {
        const query = client.query;
        wrapped.set(client, query);
        (client as { query: unknown }).query = async (...a: unknown[]) => {
          const first = a[0] as string | { text?: string } | undefined;
          const text = typeof first === 'string' ? first : (first?.text ?? '');
          const out = await (query as (...x: unknown[]) => Promise<unknown>).apply(
            client,
            a,
          );
          if (re.test(text)) await after();
          return out;
        };
      }
      return client;
    }) as typeof pool.connect;
    undo.push(() => {
      pool.connect = connect;
      for (const [client, query] of wrapped) {
        (client as { query: unknown }).query = query;
      }
    });
  }
  try {
    await fn();
  } finally {
    for (const u of undo) u();
  }
}

/** Count executions of statements whose SQL matches `re` while `fn` runs. */
async function countStatements(
  store: RunStore,
  re: RegExp,
  fn: () => Promise<void>,
): Promise<number> {
  let n = 0;
  await tapStatements(
    store,
    re,
    () => {
      n += 1;
    },
    fn,
  );
  return n;
}

/**
 * Assertions every RunStore implementation must satisfy.
 *
 * `backend` only labels the output; the assertions are identical by design —
 * that is the entire point of the file.
 */
export function describeRunStoreContract(
  backend: string,
  factory: StoreFactory,
): void {
  describe(`RunStore contract (${backend})`, () => {
    let store: RunStore;

    beforeEach(async () => {
      store = await factory.make();
    });

    afterEach(async () => {
      await factory.dispose(store);
    });

    const seed = async (id: string, ownerId: string): Promise<void> => {
      await store.upsertRun({
        id,
        orchestrationName: 'contract',
        startedAt: 1_000,
        status: 'done',
        endedAt: 2_000,
        ownerId,
        events: [
          { type: 'run-start', orchestrationName: 'contract', ts: 1_000 },
          { type: 'phase-end', phaseName: 'p', output: 'owner-visible', ts: 1_500 },
        ],
      });
    };

    describe('owner scoping is authorization, not a filter', () => {
      beforeEach(async () => {
        await seed('contract-alice', 'alice');
        await seed('contract-bob', 'bob');
      });

      it('getRun returns the run for its owner', async () => {
        const run = await store.getRun('contract-alice', 'alice');
        expect(run?.id).toBe('contract-alice');
        expect(run?.events.length).toBe(2);
      });

      it('getRun reads as MISSING for a different owner', async () => {
        // Null, not an error and not a partial — indistinguishable from a run
        // that does not exist, so a caller cannot probe which ids are real.
        expect(await store.getRun('contract-alice', 'bob')).toBeNull();
      });

      it('getRun with no owner still crosses owners (engine callers)', async () => {
        // The sweepers, the delivery worker and the run controller operate
        // across owners by design. Omitting the scope must keep working, or
        // the engine breaks.
        expect((await store.getRun('contract-alice'))?.id).toBe('contract-alice');
      });

      it('getRunSummary honours the same scope', async () => {
        expect((await store.getRunSummary('contract-alice', 'alice'))?.id).toBe(
          'contract-alice',
        );
        expect(await store.getRunSummary('contract-alice', 'bob')).toBeNull();
        expect((await store.getRunSummary('contract-alice'))?.id).toBe(
          'contract-alice',
        );
      });

      it('deleteRun refuses another owner AND leaves the row intact', async () => {
        expect(await store.deleteRun('contract-alice', 'bob')).toBe(false);
        // The half that matters: refused must mean not deleted.
        expect((await store.getRun('contract-alice'))?.id).toBe('contract-alice');
      });

      it('deleteRun succeeds for the owner and cascades to events', async () => {
        expect(await store.deleteRun('contract-alice', 'alice')).toBe(true);
        expect(await store.getRun('contract-alice')).toBeNull();
        // Bob's run is untouched — the delete was scoped, not global.
        expect((await store.getRun('contract-bob'))?.id).toBe('contract-bob');
      });

      it('deleteRun on a missing id is false, not a throw', async () => {
        expect(await store.deleteRun('contract-nope', 'alice')).toBe(false);
        expect(await store.deleteRun('contract-nope')).toBe(false);
      });

      it('costSummary scopes spend to the owner', async () => {
        // The budget cap was workspace-GLOBAL with no owner dimension, so one
        // team's runaway sweep refused every other team's runs — a
        // self-inflicted DoS whose only signal was a 402 and a log line.
        const now = Date.now();
        for (const [id, owner, cost] of [
          ['spend-alice', 'alice', 3],
          ['spend-bob', 'bob', 7],
        ] as const) {
          await store.upsertRun({
            id,
            orchestrationName: 'contract',
            startedAt: now,
            status: 'done',
            endedAt: now,
            ownerId: owner,
            events: [
              { type: 'phase-end', phaseName: 'p', costUsd: cost, ts: now },
            ],
          });
        }
        expect((await store.costSummary('alice')).monthUsd).toBeCloseTo(3);
        expect((await store.costSummary('bob')).monthUsd).toBeCloseTo(7);
        // Unscoped still reports the workspace total (the boot banner's view).
        expect((await store.costSummary()).monthUsd).toBeCloseTo(10);
      });

      it('listRuns scopes to the owner', async () => {
        const alice = await store.listRuns(100, 'alice');
        expect(alice.map(r => r.id)).toEqual(['contract-alice']);
        const all = await store.listRuns(100);
        expect(all.map(r => r.id).sort()).toEqual([
          'contract-alice',
          'contract-bob',
        ]);
      });
    });

    const running = async (
      s: RunStore,
      id: string,
      events: Array<Record<string, unknown> & { type: string }> = [],
    ): Promise<void> => {
      await s.upsertRun({
        id,
        orchestrationName: 'contract',
        startedAt: Date.now(),
        status: 'running',
        events,
      });
    };

    describe('updateRunStatus fencing (two processes, one store)', () => {
      it('a de-leased owner cannot overwrite the checkpoint', async () => {
        // appendEvent was fenced; updateRunStatus — the WHOLESALE overwrite
        // of completed_leaves / state_json the new owner resumes from — was
        // not. Proven with two handles: B records [a, b, c], de-leased A
        // writes [a], the row read [a].
        const a = await peerOf(store, 'proc-A');
        const b = await peerOf(store, 'proc-B');
        try {
          await running(a, 'fence');
          // The owner's own fenced write lands while it holds the lease.
          expect(
            await a.updateRunStatus(
              'fence',
              { completedLeaves: ['a'], stateJson: { leafOutputs: { a: 'A' } } },
              { requireLease: true },
            ),
          ).toBe(true);
          // A stalls past the TTL; B reclaims and resumes — B owns it now.
          const reclaimed = await b.markOrphanedRunsAsInterrupted(
            Date.now() + 10 * 60_000,
          );
          expect(reclaimed.ids).toContain('fence');
          await b.updateRunStatus('fence', { status: 'running' });
          expect(
            await b.updateRunStatus(
              'fence',
              {
                completedLeaves: ['a', 'b', 'c'],
                stateJson: { leafOutputs: { a: 'A', b: 'B', c: 'C' } },
              },
              { requireLease: true },
            ),
          ).toBe(true);
          // A wakes up and writes its stale checkpoint: REJECTED, not
          // silently accepted — the same answer a fenced appendEvent gives.
          await expect(
            a.updateRunStatus(
              'fence',
              { completedLeaves: ['a'], stateJson: { leafOutputs: { a: 'A' } } },
              { requireLease: true },
            ),
          ).rejects.toBeInstanceOf(LeaseLostError);
          const row = await store.getRun('fence');
          expect(row?.status).toBe('running');
          expect(row?.completedLeaves).toEqual(['a', 'b', 'c']);
          expect(row?.stateJson).toEqual({
            leafOutputs: { a: 'A', b: 'B', c: 'C' },
          });
        } finally {
          await a.close();
          await b.close();
        }
      });

      it('a de-leased owner cannot write the terminal either', async () => {
        // The B-2 shape at the store layer: reclaimed to `interrupted` with
        // the checkpoint intact, the old owner's `cancelled` must not land —
        // a cancelled row is terminal and resume() refuses it.
        const a = await peerOf(store, 'proc-A');
        const b = await peerOf(store, 'proc-B');
        try {
          await running(a, 'term');
          await a.updateRunStatus(
            'term',
            { completedLeaves: ['a'] },
            { requireLease: true },
          );
          await b.markOrphanedRunsAsInterrupted(Date.now() + 10 * 60_000);
          await expect(
            a.updateRunStatus(
              'term',
              { status: 'cancelled', endedAt: Date.now() },
              { requireLease: true },
            ),
          ).rejects.toBeInstanceOf(LeaseLostError);
          const row = await store.getRun('term');
          expect(row?.status).toBe('interrupted');
          expect(row?.completedLeaves).toEqual(['a']);
        } finally {
          await a.close();
          await b.close();
        }
      });

      it('the UNFENCED write still crosses processes (the admin cancel path)', async () => {
        // Deliberately preserved: an operator's cancel from another process
        // flips a running row it does not own. The fence is opt-in so this
        // path keeps working exactly as before.
        const a = await peerOf(store, 'proc-A');
        const b = await peerOf(store, 'proc-B');
        try {
          await running(a, 'admin');
          expect(
            await b.updateRunStatus('admin', {
              status: 'cancelled',
              endedAt: Date.now(),
            }),
          ).toBe(true);
          expect((await store.getRun('admin'))?.status).toBe('cancelled');
        } finally {
          await a.close();
          await b.close();
        }
      });

      it('a fenced write to an unknown run throws LeaseLostError', async () => {
        await expect(
          store.updateRunStatus(
            'contract-missing',
            { lastOutput: 'x' },
            { requireLease: true },
          ),
        ).rejects.toBeInstanceOf(LeaseLostError);
      });

      it('onlyIfStatus makes the resume flip a claim: the second caller gets false', async () => {
        await running(store, 'claim');
        await store.updateRunStatus('claim', {
          status: 'paused',
          pausedFor: 'gate',
        });
        const resumable = ['paused', 'interrupted', 'error'] as const;
        const flip = () =>
          store.updateRunStatus(
            'claim',
            { status: 'running', pausedFor: null, endedAt: null },
            { onlyIfStatus: [...resumable] },
          );
        expect(await flip()).toBe(true);
        // Already running: not a resumable state, so the claim misses — a
        // lost race, reported as false rather than thrown.
        expect(await flip()).toBe(false);
        expect((await store.getRun('claim'))?.status).toBe('running');
      });
    });

    describe('orphan reclaim', () => {
      it('a store does not reclaim its OWN expired-lease run; a peer does', async () => {
        // Boot-only, this could not happen (a fresh process has a fresh id).
        // As a periodic sweep it could: a blocked event loop let a process
        // reclaim its own live run, and the renew that followed then aborted
        // the work it was still doing.
        await running(store, 'own');
        const later = Date.now() + 10 * 60_000;
        expect((await store.markOrphanedRunsAsInterrupted(later)).ids).not.toContain(
          'own',
        );
        expect((await store.getRun('own'))?.status).toBe('running');
        const peer = await peerOf(store, 'contract-peer');
        try {
          expect((await peer.markOrphanedRunsAsInterrupted(later)).ids).toContain(
            'own',
          );
        } finally {
          await peer.close();
        }
        expect((await store.getRun('own'))?.status).toBe('interrupted');
      });

      it('the run-interrupted event states the cause, not "restarted on boot"', async () => {
        await running(store, 'why', [{ type: 'run-start' }]);
        const peer = await peerOf(store, 'contract-peer');
        try {
          await peer.markOrphanedRunsAsInterrupted(Date.now() + 10 * 60_000);
        } finally {
          await peer.close();
        }
        const run = await store.getRun('why');
        const marker = run?.events[run.events.length - 1] as
          | Record<string, unknown>
          | undefined;
        expect(marker?.type).toBe('run-interrupted');
        const reason = String(marker?.reason);
        expect(reason).toMatch(/lease expired at \d{4}-\d{2}-\d{2}T/);
        expect(reason).toMatch(/reclaimed by contract-peer/i);
        expect(reason).not.toMatch(/on boot/i);
        expect(typeof marker?.leaseExpiredAt).toBe('number');
        expect(typeof marker?.previousOwner).toBe('string');
        expect(marker?.reclaimedBy).toBe('contract-peer');
      });

      it('an own expired-lease row IS reclaimed when the caller vouches it no longer drives it', async () => {
        // The exclusion protects a LIVE own run. A leg whose terminal write
        // failed every retry has let go of its row (heartbeat stopped,
        // controller gone), and in a single-process deployment no peer
        // exists to reclaim it — so the same store must, but only on the
        // caller's word that the row is not driven here any more.
        await running(store, 'own-abandoned');
        const later = Date.now() + 10 * 60_000;
        expect(
          (await store.markOrphanedRunsAsInterrupted(later, { isLocallyActive: () => true }))
            .ids,
        ).not.toContain('own-abandoned');
        expect((await store.getRun('own-abandoned'))?.status).toBe('running');
        expect(
          (await store.markOrphanedRunsAsInterrupted(later, { isLocallyActive: () => false }))
            .ids,
        ).toContain('own-abandoned');
        const run = await store.getRun('own-abandoned');
        expect(run?.status).toBe('interrupted');
        expect(run?.events[run.events.length - 1]?.type).toBe('run-interrupted');
      });

      it('a vouched own row still needs an EXPIRED lease — a live lease is never reclaimed', async () => {
        await running(store, 'own-live');
        expect(
          (await store.markOrphanedRunsAsInterrupted(Date.now(), { isLocallyActive: () => false }))
            .ids,
        ).not.toContain('own-live');
        expect((await store.getRun('own-live'))?.status).toBe('running');
      });
    });

    describe('costSummary', () => {
      it('sums phase-end only — the cumulative `cost` events do not stack', async () => {
        // The executor emits `cost` with the run's CUMULATIVE total after
        // every agent phase. Summing every type counted 3 × $1 as $9. The
        // older fixtures held only phase-ends, which is how it stayed hidden.
        const now = Date.now();
        await store.upsertRun({
          id: 'spend-cumulative',
          orchestrationName: 'contract',
          startedAt: now,
          status: 'done',
          endedAt: now,
          events: [
            { type: 'phase-end', phaseName: 'a', costUsd: 1, ts: now },
            { type: 'cost', costUsd: 1, ts: now },
            { type: 'phase-end', phaseName: 'b', costUsd: 1, ts: now },
            { type: 'cost', costUsd: 2, ts: now },
            { type: 'phase-end', phaseName: 'c', costUsd: 1, ts: now },
            { type: 'cost', costUsd: 3, ts: now },
          ],
        });
        const summary = await store.costSummary();
        expect(summary.monthUsd).toBeCloseTo(3);
        expect(summary.todayUsd).toBeCloseTo(3);
      });

      it("counts a failed attempt's phase-error cost — a retry storm is not free", async () => {
        // A leaf that fails before its phase-end (contract violation, failed
        // turn) and is re-dispatched by `retry` paid for every attempt; with
        // the readers folding phase-ends only, the cap saw $0 of it. The
        // leaf's own phase-error now carries its attempt's delta.
        const now = Date.now();
        await store.upsertRun({
          id: 'spend-failed-attempt',
          orchestrationName: 'contract',
          startedAt: now,
          status: 'done',
          endedAt: now,
          events: [
            { type: 'phase-error', phaseName: 'a', error: 'bad', costUsd: 2, ts: now },
            { type: 'node-retried', phaseName: 'a', attempt: 1, ts: now },
            { type: 'phase-end', phaseName: 'a', costUsd: 1, ts: now },
            { type: 'cost', costUsd: 3, ts: now },
          ],
        });
        const summary = await store.costSummary();
        expect(summary.monthUsd).toBeCloseTo(3);
        expect(summary.todayUsd).toBeCloseTo(3);
        // The per-run reader (sumCostUsd, via the summary) folds the same.
        expect((await store.getRunSummary('spend-failed-attempt'))?.costUsd).toBeCloseTo(3);
      });
    });

    describe('intake admission reads + held deliveries', () => {
      it('orchestrationUsage scopes runs and spend to one orchestration and window', async () => {
        const now = Date.now();
        const dayStart = now - 3_600_000;
        const monthStart = now - 10 * DAY;
        const run = (id: string, orch: string, startedAt: number, cost: number) =>
          store.upsertRun({
            id,
            orchestrationName: orch,
            startedAt,
            status: 'done',
            endedAt: startedAt,
            events: [
              { type: 'phase-end', phaseName: 'a', costUsd: cost, ts: startedAt },
              { type: 'cost', costUsd: cost * 10, ts: startedAt },
            ],
          });
        await run('u-today-1', 'intake', now, 1);
        await run('u-today-2', 'intake', now, 2);
        await run('u-earlier', 'intake', now - 2 * DAY, 4); // this month, not today
        await run('u-old', 'intake', now - 40 * DAY, 8); // outside both windows
        await run('u-other', 'other', now, 16);
        const u = await store.orchestrationUsage!('intake', { dayStart, monthStart });
        expect(u.runsToday).toBe(2);
        expect(u.todayUsd).toBeCloseTo(3);
        expect(u.monthUsd).toBeCloseTo(7);
        expect(await store.orchestrationUsage!('none', { dayStart, monthStart })).toEqual({
          runsToday: 0,
          todayUsd: 0,
          monthUsd: 0,
        });
      });

      it('holdDelivery requeues for later, refunds the attempt, and is fenced', async () => {
        await store.recordDelivery({
          id: 'hold-1',
          kind: 'queue',
          name: 'q',
          orchestrationName: 'intake',
          idempotencyKey: 'k-hold-1',
          keySource: 'window',
          status: 'pending',
          body: 'b',
          receivedAt: 1,
          availableAt: 1,
        });
        const claimed = await store.claimNextDelivery(100);
        expect(claimed?.id).toBe('hold-1');
        expect(
          await store.holdDelivery!('hold-1', { until: 9_000, detail: 'paused', claimToken: claimed!.claimToken + 1 }),
        ).toBe(false);
        expect(
          await store.holdDelivery!('hold-1', { until: 9_000, detail: 'paused', claimToken: claimed!.claimToken }),
        ).toBe(true);
        const [d] = (await store.listDeliveries(10)).filter(x => x.id === 'hold-1');
        expect(d).toMatchObject({ status: 'pending', availableAt: 9_000, attempts: 0, detail: 'paused', keySource: 'window' });
        expect(await store.claimNextDelivery(200)).toBeNull();
        expect(await store.countDeliveries({ status: 'pending', availableBefore: 200 })).toBe(0);
        expect(await store.releaseDeliveries!('intake', 300)).toBe(1);
        expect((await store.claimNextDelivery(300))?.id).toBe('hold-1');
      });

      it('dueOrRetrying counts due and backing-off rows, never held ones', async () => {
        const base = {
          kind: 'queue',
          name: 'q',
          orchestrationName: 'bp',
          keySource: 'auto' as const,
          status: 'pending' as const,
          body: 'b',
          receivedAt: 1,
        };
        // One row at a time, so each claim is deterministic.
        // bp-retry: claimed, failed, backing off until 5_000.
        await store.recordDelivery({ ...base, id: 'bp-retry', idempotencyKey: 'bp-2', availableAt: 1 });
        const c = await store.claimNextDelivery(10);
        expect(c?.id).toBe('bp-retry');
        await store.failDelivery('bp-retry', { error: 'boom', now: 10, retryAt: 5_000, claimToken: c!.claimToken });
        // bp-held: claimed, then HELD until 9_000 (a hold clears last_error).
        await store.recordDelivery({ ...base, id: 'bp-held', idempotencyKey: 'bp-3', availableAt: 1 });
        const h = await store.claimNextDelivery(10);
        expect(h?.id).toBe('bp-held');
        await store.failDelivery('bp-held', { error: 'first try', now: 10, retryAt: 1, claimToken: h!.claimToken });
        const h2 = await store.claimNextDelivery(10);
        expect(h2?.id).toBe('bp-held');
        await store.holdDelivery!('bp-held', { until: 9_000, detail: 'paused', claimToken: h2!.claimToken });
        // bp-due: fresh and due.
        await store.recordDelivery({ ...base, id: 'bp-due', idempotencyKey: 'bp-1', availableAt: 1 });
        const rows = (await store.listDeliveries(50)).filter(d => d.orchestrationName === 'bp');
        expect(rows.find(r => r.id === 'bp-held')?.lastError).toBeNull();
        expect(await store.countDeliveries({ status: 'pending', dueOrRetrying: 100 })).toBe(2);
      });
    });

    describe('pruneTerminalRuns batching', () => {
      it('drains a backlog larger than one batch, in batches (SAMMY_RETENTION_BATCH=2, 5 rows)', async () => {
        // One unbatched DELETE was a single statement that, past some store
        // size, hits statement_timeout every day forever (Postgres) or
        // freezes the event loop past the lease TTL (SQLite). Batched, each
        // statement is bounded. The statement count is the proof: ceil(5/2)
        // batch SELECTs, not one.
        const now = Date.now();
        const old = now - 40 * DAY;
        const seed = async (id: string, status: 'done' | 'paused', endedAt: number | null) =>
          store.upsertRun({
            id,
            orchestrationName: 'contract',
            startedAt: (endedAt ?? now) - 1_000,
            endedAt,
            status,
            events: [{ type: 'run-start', ts: 1 }, { type: 'phase-end', ts: 2 }],
          });
        for (let i = 0; i < 5; i++) await seed(`prune-${i}`, 'done', old);
        await seed('prune-paused', 'paused', null); // protected, however old
        await seed('prune-recent', 'done', now - DAY); // inside the window
        process.env.SAMMY_RETENTION_BATCH = '2';
        let res: { count: number } = { count: -1 };
        let batches = 0;
        try {
          batches = await countStatements(
            store,
            /SELECT id FROM runs[\s\S]*LIMIT/,
            async () => {
              res = await store.pruneTerminalRuns(30 * DAY, now);
            },
          );
        } finally {
          delete process.env.SAMMY_RETENTION_BATCH;
        }
        expect(res.count).toBe(5);
        expect(batches).toBe(3);
        for (let i = 0; i < 5; i++) {
          expect(await store.getRun(`prune-${i}`)).toBeNull();
        }
        expect((await store.getRun('prune-paused'))?.status).toBe('paused');
        expect((await store.getRun('prune-recent'))?.status).toBe('done');
      });

      it('a row resumed between the SELECT and the DELETE survives, events and all', async () => {
        // The batch selected terminal ids, then deleted BY ID with no status
        // predicate. A resume's CAS (`error → running`) committing in the
        // gap deleted the now-live run and its whole event stream.
        const now = Date.now();
        const old = now - 40 * DAY;
        for (const id of ['prune-a', 'prune-live', 'prune-b']) {
          await store.upsertRun({
            id,
            orchestrationName: 'contract',
            startedAt: old - 1_000,
            endedAt: old,
            status: 'error',
            events: [{ type: 'run-start', ts: 1 }, { type: 'phase-end', ts: 2 }],
          });
        }
        const peer = await peerOf(store, 'resumer');
        let res: { count: number } = { count: -1 };
        try {
          await tapStatements(
            store,
            /SELECT id FROM runs[\s\S]*LIMIT/,
            async () => {
              await peer.updateRunStatus(
                'prune-live',
                { status: 'running', endedAt: null },
                { onlyIfStatus: ['error'] },
              );
            },
            async () => {
              res = await store.pruneTerminalRuns(30 * DAY, now);
            },
          );
        } finally {
          await peer.close();
        }
        expect(res.count).toBe(2);
        expect(await store.getRun('prune-a')).toBeNull();
        expect(await store.getRun('prune-b')).toBeNull();
        const live = await store.getRun('prune-live');
        expect(live?.status).toBe('running');
        expect(live?.events.length).toBe(2);
      });
    });
  });
}

// The preset treats every `__tests__/*.ts` as a suite; this keeps the file
// honest about being a helper rather than failing as an empty one.
describe('run-store contract helpers', () => {
  it('exports the contract generator both backends call', () => {
    expect(typeof describeRunStoreContract).toBe('function');
  });
});
