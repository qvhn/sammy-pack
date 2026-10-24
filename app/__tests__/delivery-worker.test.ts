import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteRunStore } from '../src/server/db';
import {
  DeliveryWorker,
  type RunDeliveryResult,
} from '../src/server/delivery-worker';

let tmpRoot: string;
let store: SqliteRunStore | null = null;

async function freshStore(): Promise<SqliteRunStore> {
  store = new SqliteRunStore(tmpRoot);
  await store.init();
  return store;
}

async function enqueue(
  s: SqliteRunStore,
  id: string,
  overrides: Partial<Parameters<SqliteRunStore['recordDelivery']>[0]> = {},
): Promise<void> {
  await s.recordDelivery({
    id,
    kind: 'webhook',
    name: 'n',
    orchestrationName: 'o',
    idempotencyKey: `k-${id}`,
    keySource: 'header',
    status: 'pending',
    body: 'b',
    receivedAt: 1,
    availableAt: 1,
    ...overrides,
  });
}

async function statusOf(s: SqliteRunStore, id: string) {
  return (await s.listDeliveries(1000)).find(d => d.id === id);
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-worker-'));
});
afterEach(async () => {
  await store?.close();
  store = null;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('DeliveryWorker', () => {
  it('claims a pending delivery, fires the run, marks it fired', async () => {
    const s = await freshStore();
    await enqueue(s, 'd1');
    const worker = new DeliveryWorker({
      store: s,
      now: () => 1000,
      runDelivery: async () => ({ ok: true, runId: 'run-1' }),
    });
    const processed = await worker.processOne();
    expect(processed?.id).toBe('d1');
    const got = await statusOf(s, 'd1');
    expect(got?.status).toBe('fired');
    expect(got?.runId).toBe('run-1');
    expect(got?.attempts).toBe(1);
    expect(got?.claimedAt).toBeNull();
  });

  it('processOne returns null when nothing is claimable', async () => {
    const s = await freshStore();
    const worker = new DeliveryWorker({
      store: s,
      runDelivery: async () => ({ ok: true, runId: 'x' }),
    });
    expect(await worker.processOne()).toBeNull();
  });

  it('drain processes every pending delivery', async () => {
    const s = await freshStore();
    await enqueue(s, 'a', { receivedAt: 1 });
    await enqueue(s, 'b', { receivedAt: 2 });
    await enqueue(s, 'c', { receivedAt: 3 });
    let calls = 0;
    const worker = new DeliveryWorker({
      store: s,
      now: () => 1000,
      runDelivery: async () => {
        calls += 1;
        return { ok: true, runId: `run-${calls}` };
      },
    });
    expect(await worker.drain()).toBe(3);
    expect(calls).toBe(3);
    expect((await s.listDeliveries(10)).every(d => d.status === 'fired')).toBe(
      true,
    );
  });

  it('non-retryable failure → rejected, no retry', async () => {
    const s = await freshStore();
    await enqueue(s, 'd');
    const worker = new DeliveryWorker({
      store: s,
      now: () => 1000,
      runDelivery: async (): Promise<RunDeliveryResult> => ({
        ok: false,
        error: 'budget blocked',
        retryable: false,
      }),
    });
    await worker.processOne();
    const got = await statusOf(s, 'd');
    expect(got?.status).toBe('rejected');
    expect(got?.lastError).toBe('budget blocked');
    expect(got?.attempts).toBe(1);
  });

  it('retryable failure requeues with backoff, then succeeds when due', async () => {
    const s = await freshStore();
    await enqueue(s, 'd');
    const clock = { t: 1000 };
    let calls = 0;
    const worker = new DeliveryWorker({
      store: s,
      now: () => clock.t,
      maxAttempts: 5,
      backoffMs: () => 1000,
      runDelivery: async (): Promise<RunDeliveryResult> => {
        calls += 1;
        return calls === 1
          ? { ok: false, error: 'transient', retryable: true }
          : { ok: true, runId: 'run-ok' };
      },
    });

    // 1st claim fails → requeued with available_at = now + 1000.
    await worker.processOne();
    let got = await statusOf(s, 'd');
    expect(got?.status).toBe('pending');
    expect(got?.availableAt).toBe(2000);
    expect(got?.lastError).toBe('transient');

    // Not yet due → nothing claimable.
    expect(await worker.processOne()).toBeNull();

    // Advance past the backoff → claimed again and succeeds.
    clock.t = 2000;
    await worker.processOne();
    got = await statusOf(s, 'd');
    expect(got?.status).toBe('fired');
    expect(got?.runId).toBe('run-ok');
    expect(got?.attempts).toBe(2);
  });

  it('dead-letters after exhausting maxAttempts', async () => {
    const s = await freshStore();
    await enqueue(s, 'd');
    const worker = new DeliveryWorker({
      store: s,
      now: () => 1000,
      maxAttempts: 2,
      backoffMs: () => 0, // immediately re-claimable
      runDelivery: async (): Promise<RunDeliveryResult> => ({
        ok: false,
        error: 'boom',
        retryable: true,
      }),
    });
    await worker.processOne(); // attempt 1 → retry (available now)
    expect((await statusOf(s, 'd'))?.status).toBe('pending');
    await worker.processOne(); // attempt 2 → exhausted → failed
    const got = await statusOf(s, 'd');
    expect(got?.status).toBe('failed');
    expect(got?.lastError).toBe('boom');
    expect(got?.attempts).toBe(2);
  });

  it('a thrown handler is treated as a retryable failure', async () => {
    const s = await freshStore();
    await enqueue(s, 'd');
    const worker = new DeliveryWorker({
      store: s,
      now: () => 1000,
      maxAttempts: 1, // one try → throw dead-letters immediately
      runDelivery: async () => {
        throw new Error('kaboom');
      },
    });
    await worker.processOne();
    const got = await statusOf(s, 'd');
    expect(got?.status).toBe('failed');
    expect(got?.lastError).toContain('kaboom');
  });
});

describe('stop() — a worker must actually be stoppable', () => {
  /**
   * THE BUG THIS PINS: `stop()` cleared every pending sleep timer, but each
   * sleep promise was resolved ONLY from inside that timer's callback. So
   * clearing it stranded the promise, the loop never returned, and
   * `await Promise.allSettled(this.loops)` never resolved. An idle worker
   * spends essentially all its time in that 500ms sleep, so this was the
   * NORMAL case, not an edge: `npm run worker` could not be shut down.
   * SIGTERM hung, `store.close()` and `process.exit(0)` never ran, and a
   * second Ctrl-C was swallowed by the `stopping` latch — SIGKILL was the
   * only way out, which in turn orphans claimed deliveries until their
   * leases expire.
   *
   * Each case races `stop()` against a timeout: on the old code the race is
   * lost and the test fails rather than hanging the suite.
   */
  const withTimeout = async (p: Promise<unknown>, ms = 3_000): Promise<'done' | 'hung'> =>
    Promise.race([
      p.then(() => 'done' as const),
      new Promise<'hung'>(r => setTimeout(() => r('hung'), ms)),
    ]);

  it('resolves promptly when the worker is idle (mid-sleep)', async () => {
    const s = await freshStore();
    const worker = new DeliveryWorker({
      store: s,
      runDelivery: async () => ({ ok: true, runId: 'r' }) as RunDeliveryResult,
    });
    worker.start();
    // Let every loop reach its sleep — the state the old code could not exit.
    await new Promise(r => setTimeout(r, 50));

    expect(await withTimeout(worker.stop())).toBe('done');
  });

  it('is idempotent — a second stop() also resolves', async () => {
    const s = await freshStore();
    const worker = new DeliveryWorker({
      store: s,
      runDelivery: async () => ({ ok: true, runId: 'r' }) as RunDeliveryResult,
    });
    worker.start();
    await new Promise(r => setTimeout(r, 50));

    expect(await withTimeout(worker.stop())).toBe('done');
    expect(await withTimeout(worker.stop())).toBe('done');
  });

  it('stops even with queued work, and stops claiming after', async () => {
    const s = await freshStore();
    let delivered = 0;
    const worker = new DeliveryWorker({
      store: s,
      runDelivery: async () => {
        delivered += 1;
        return { ok: true, runId: `r${delivered}` } as RunDeliveryResult;
      },
    });
    for (let i = 0; i < 5; i++) await enqueue(s, `d${i}`);
    worker.start();
    await new Promise(r => setTimeout(r, 150));

    expect(await withTimeout(worker.stop())).toBe('done');
    const afterStop = delivered;
    // Nothing may be claimed once stop() has returned.
    await enqueue(s, 'post-stop');
    await new Promise(r => setTimeout(r, 150));
    expect(delivered).toBe(afterStop);
    expect((await statusOf(s, 'post-stop'))?.status).toBe('pending');
  });
});

describe('claim fencing — one accepted fire must not become two runs', () => {
  /**
   * THE BUG THIS PINS: runs have had lease fencing for a long time;
   * deliveries had none. Their terminal updates were `WHERE id = ?` with no
   * status or token guard, and there is no claim heartbeat. So a worker that
   * stalled past `reclaimAfterMs` (60s default — a GC pause, a suspended
   * laptop, or the delegate-mode fetch that had no timeout) had its delivery
   * swept back to `pending`, re-claimed by another worker, and RUN AGAIN —
   * and then the first worker woke up and wrote its own result over the top.
   * Two live orchestration runs from one accepted fire, with the audit row
   * recording only one of them.
   *
   * The fence is `claim_token`: bumped on every claim, never reset. These
   * cases drive the interleaving directly against the real store.
   */

  it('a stale owner cannot complete a delivery that was reclaimed', async () => {
    const s = await freshStore();
    await enqueue(s, 'd1');

    // Worker A claims.
    const a = await s.claimNextDelivery(1_000);
    expect(a!.claimToken).toBe(1);

    // A stalls; the sweeper reclaims; worker B claims and runs it.
    await s.reclaimStaleDeliveries(0, 2_000);
    const b = await s.claimNextDelivery(3_000);
    expect(b!.id).toBe('d1');
    expect(b!.claimToken).toBe(2); // monotonic — A's token is now stale
    expect(await s.completeDelivery('d1', 'run-B', 4_000, b!.claimToken)).toBe(true);

    // A finally wakes up. Its write must be REFUSED, not applied.
    expect(await s.completeDelivery('d1', 'run-A', 5_000, a!.claimToken)).toBe(false);
    const row = await statusOf(s, 'd1');
    expect(row?.status).toBe('fired');
    expect(row?.runId).toBe('run-B'); // B's run, not overwritten by A's
  });

  it('a stale owner cannot REQUEUE a delivery another worker is running', async () => {
    // The nastier variant: a stale failDelivery(retryAt) would flip a row
    // that is mid-run back to `pending`, yielding a THIRD run.
    const s = await freshStore();
    await enqueue(s, 'd2');
    const a = await s.claimNextDelivery(1_000);
    await s.reclaimStaleDeliveries(0, 2_000);
    const b = await s.claimNextDelivery(3_000);

    expect(
      await s.failDelivery('d2', {
        error: 'stale owner gives up',
        now: 4_000,
        retryAt: 9_000,
        claimToken: a!.claimToken,
      }),
    ).toBe(false);
    // Still claimed by B, not requeued.
    const row = await statusOf(s, 'd2');
    expect(row?.status).toBe('claimed');
    expect(row?.claimToken).toBe(b!.claimToken);
  });

  it('a stale owner cannot reject or dead-letter either', async () => {
    const s = await freshStore();
    await enqueue(s, 'd3');
    const a = await s.claimNextDelivery(1_000);
    await s.reclaimStaleDeliveries(0, 2_000);
    const b = await s.claimNextDelivery(3_000);

    expect(await s.rejectDelivery('d3', 'stale', 4_000, a!.claimToken)).toBe(false);
    expect(
      await s.failDelivery('d3', {
        error: 'stale',
        now: 4_000,
        claimToken: a!.claimToken,
      }),
    ).toBe(false);
    // The live owner still settles normally.
    expect(await s.completeDelivery('d3', 'run-B', 5_000, b!.claimToken)).toBe(true);
  });

  it('the token survives a replay, which resets only the retry budget', async () => {
    // `attempts` is the retry budget and replayDelivery resets it to 0, which
    // is why attempts cannot be the fence: a reset would let an old token
    // match again.
    const s = await freshStore();
    await enqueue(s, 'd4');
    const first = await s.claimNextDelivery(1_000);
    await s.failDelivery('d4', {
      error: 'boom',
      now: 2_000,
      claimToken: first!.claimToken,
    });
    expect((await statusOf(s, 'd4'))?.status).toBe('failed');

    expect(await s.replayDelivery('d4', 3_000)).toBe(true);
    const replayed = await statusOf(s, 'd4');
    expect(replayed?.attempts).toBe(0); // budget reset …
    expect(replayed?.claimToken).toBe(1); // … fence NOT reset

    const second = await s.claimNextDelivery(4_000);
    expect(second!.claimToken).toBe(2);
    // The pre-replay token must not settle the post-replay claim.
    expect(await s.completeDelivery('d4', 'ghost', 5_000, first!.claimToken)).toBe(
      false,
    );
    expect(await s.completeDelivery('d4', 'real', 5_000, second!.claimToken)).toBe(
      true,
    );
  });

  it('reclaim cannot resurrect a delivery that was already settled', async () => {
    // The select and the update must be one atomic, re-checked step: the
    // unguarded version forced an already-`fired` row back to `pending` when
    // a peer settled it in the gap, re-running completed work.
    const s = await freshStore();
    await enqueue(s, 'd5');
    const c = await s.claimNextDelivery(1_000);
    expect(await s.completeDelivery('d5', 'run-1', 1_500, c!.claimToken)).toBe(true);

    // A sweep with a cutoff that would have matched the original claim.
    const swept = await s.reclaimStaleDeliveries(0, 9_000);
    expect(swept.ids).not.toContain('d5');
    expect((await statusOf(s, 'd5'))?.status).toBe('fired');
  });

  it('the WORKER reports a lost claim instead of assuming success', async () => {
    const s = await freshStore();
    await enqueue(s, 'd6');
    const logs: string[] = [];
    const worker = new DeliveryWorker({
      store: s,
      log: m => logs.push(m),
      // While the handler "runs", steal the delivery the way the sweeper
      // plus another worker would.
      runDelivery: async () => {
        await s.reclaimStaleDeliveries(0, Date.now() + 1);
        const thief = await s.claimNextDelivery(Date.now() + 2);
        await s.completeDelivery('d6', 'run-thief', Date.now() + 3, thief!.claimToken);
        return { ok: true, runId: 'run-mine' } as RunDeliveryResult;
      },
    });

    await worker.processOne();

    // The thief's result stands; the stale worker's is discarded and SAID SO.
    const row = await statusOf(s, 'd6');
    expect(row?.runId).toBe('run-thief');
    expect(logs.join('\n')).toMatch(/LOST ITS CLAIM/);
  });
});

describe('a closed store means shutdown, not an error to log', () => {
  /**
   * THE BUG THIS PINS: the mount's close hook calls `stop()` WITHOUT awaiting
   * it and then closes the store, so an in-flight drain reliably meets a dead
   * connection. On a fast machine the window is too small to notice; on a
   * slow CI runner (~4.7x slower) it is hit every time — and the resulting
   * log lands AFTER the test that owned the mount has finished, which jest
   * reports as "Cannot log after tests are done" and turns into a non-zero
   * exit with every single test still passing. That is how CI went red on a
   * green suite.
   *
   * Staying quiet on a closed store fixes the exit code and is also the
   * honest behaviour: there is nothing to report about work that was
   * deliberately torn down.
   */
  it('does not log when the store closes under a running loop', async () => {
    const s = await freshStore();
    await enqueue(s, 'd1');
    const logs: string[] = [];
    const worker = new DeliveryWorker({
      store: s,
      log: m => logs.push(m),
      runDelivery: async () => ({ ok: true, runId: 'r' }) as RunDeliveryResult,
    });
    worker.start();
    // Close the store out from under the loop, the way mount.kill() does.
    await s.close();
    // Give the loop several iterations against the dead store.
    await new Promise(r => setTimeout(r, 150));

    expect(logs.filter(m => /database|not open|closed/i.test(m))).toEqual([]);
    expect(logs).toEqual([]);
    await worker.stop();
  });

  it('a kick after the store closed is silent too', async () => {
    const s = await freshStore();
    const logs: string[] = [];
    const worker = new DeliveryWorker({
      store: s,
      log: m => logs.push(m),
      runDelivery: async () => ({ ok: true, runId: 'r' }) as RunDeliveryResult,
    });
    worker.start();
    await s.close();
    // The low-latency nudge path has its own catch, so it needs its own case.
    worker.kick();
    await new Promise(r => setTimeout(r, 150));

    expect(logs).toEqual([]);
    await worker.stop();
  });

  it('a REAL error is still reported', async () => {
    // The fix must not become a blanket swallow.
    const s = await freshStore();
    await enqueue(s, 'd2');
    const logs: string[] = [];
    const worker = new DeliveryWorker({
      store: s,
      log: m => logs.push(m),
      runDelivery: async () => {
        throw new Error('handler exploded');
      },
    });
    worker.start();
    await new Promise(r => setTimeout(r, 200));
    await worker.stop();

    expect(logs.join('\n')).toMatch(/handler exploded/);
  });
});

describe('DeliveryWorker — hold', () => {
  it('requeues a held delivery for `until` and refunds the attempt', async () => {
    const s = await freshStore();
    await enqueue(s, 'h1');
    const results: RunDeliveryResult[] = [
      { ok: false, hold: true, until: 5000, detail: 'paused' },
      { ok: true, runId: 'run-h' },
    ];
    let clock = 1000;
    const worker = new DeliveryWorker({
      store: s,
      now: () => clock,
      maxAttempts: 1,
      runDelivery: async () => results.shift()!,
    });
    await worker.processOne();
    let d = await statusOf(s, 'h1');
    expect(d).toMatchObject({ status: 'pending', availableAt: 5000, attempts: 0, detail: 'paused' });
    // Not claimable before `until`…
    expect(await worker.processOne()).toBeNull();
    // …and, holds never having spent an attempt, it still runs with maxAttempts 1.
    clock = 5000;
    await worker.processOne();
    d = await statusOf(s, 'h1');
    expect(d).toMatchObject({ status: 'fired', runId: 'run-h' });
  });

  it('holding forever never dead-letters', async () => {
    const s = await freshStore();
    await enqueue(s, 'h2');
    let clock = 1000;
    const worker = new DeliveryWorker({
      store: s,
      now: () => clock,
      maxAttempts: 2,
      runDelivery: async () => ({ ok: false, hold: true, until: clock + 1, detail: 'capped' }),
    });
    for (let i = 0; i < 10; i += 1) {
      await worker.processOne();
      clock += 1;
    }
    expect((await statusOf(s, 'h2'))?.status).toBe('pending');
  });

  it('releaseDeliveries makes held rows due now; countDeliveries can exclude them', async () => {
    const s = await freshStore();
    await enqueue(s, 'r1', { availableAt: 10_000_000 });
    await enqueue(s, 'r2', { availableAt: 10_000_000, orchestrationName: 'other' });
    expect(await s.countDeliveries({ status: 'pending', availableBefore: 1000 })).toBe(0);
    expect(await s.countDeliveries({ status: 'pending' })).toBe(2);
    expect(await s.releaseDeliveries('o', 2000)).toBe(1);
    expect((await statusOf(s, 'r1'))?.availableAt).toBe(2000);
    expect((await statusOf(s, 'r2'))?.availableAt).toBe(10_000_000);
  });
});
