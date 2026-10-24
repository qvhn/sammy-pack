import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteRunStore } from '../src/server/db';
import type { RunStore, UpsertRunInput } from '../src/server/run-store';
import {
  concurrencyOf,
  cronOverlapOf,
  decideConcurrency,
  DEFAULT_CONCURRENCY_POLICY,
  DEFAULT_CRON_OVERLAP,
  DurableGroupLock,
  effectiveConcurrency,
  GroupLock,
} from '../src/server/concurrency-group';
import type { Node } from '../src/types';

let tmpRoot: string;
let store: SqliteRunStore | null = null;

async function freshStore(): Promise<SqliteRunStore> {
  store = new SqliteRunStore(tmpRoot);
  await store.init();
  return store;
}

/** Minimal run-row helper — only the fields the concurrency queries read. */
async function seedRun(
  s: RunStore,
  over: Partial<UpsertRunInput> & { id: string },
): Promise<void> {
  await s.upsertRun({
    orchestrationName: 'o',
    startedAt: Date.now(),
    status: 'running',
    events: [],
    ...over,
  });
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-conc-'));
});

afterEach(async () => {
  await store?.close();
  store = null;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ── Store: findActiveRunsInGroup ──────────────────────────────────────────

describe('findActiveRunsInGroup (store layer)', () => {
  it('filters by group AND active status, ignoring terminal runs', async () => {
    const s = await freshStore();
    await seedRun(s, { id: 'a-run', status: 'running', concurrencyGroup: 'staging' });
    await seedRun(s, { id: 'a-paused', status: 'paused', concurrencyGroup: 'staging' });
    await seedRun(s, { id: 'a-done', status: 'done', concurrencyGroup: 'staging' });
    await seedRun(s, { id: 'a-error', status: 'error', concurrencyGroup: 'staging' });
    await seedRun(s, { id: 'a-cancelled', status: 'cancelled', concurrencyGroup: 'staging' });

    const active = await s.findActiveRunsInGroup('staging');
    expect(active.map(r => r.id).sort()).toEqual(['a-paused', 'a-run']);
    // The header round-trips the group.
    expect(active.every(r => r.concurrencyGroup === 'staging')).toBe(true);
  });

  it('isolates by group and never matches a null group', async () => {
    const s = await freshStore();
    await seedRun(s, { id: 'g1', status: 'running', concurrencyGroup: 'env-a' });
    await seedRun(s, { id: 'g2', status: 'running', concurrencyGroup: 'env-b' });
    await seedRun(s, { id: 'g3', status: 'running' }); // no group → null

    expect((await s.findActiveRunsInGroup('env-a')).map(r => r.id)).toEqual(['g1']);
    expect((await s.findActiveRunsInGroup('env-b')).map(r => r.id)).toEqual(['g2']);
    expect(await s.findActiveRunsInGroup('env-missing')).toEqual([]);
  });

  it('excludes excludeRunId (a run never blocks itself)', async () => {
    const s = await freshStore();
    await seedRun(s, { id: 'self', status: 'running', concurrencyGroup: 'shared' });
    await seedRun(s, { id: 'other', status: 'running', concurrencyGroup: 'shared' });

    const others = await s.findActiveRunsInGroup('shared', 'self');
    expect(others.map(r => r.id)).toEqual(['other']);
  });
});

// ── Store: pending-fire FIFO queue ────────────────────────────────────────

describe('pending_fires queue (store layer)', () => {
  it('enqueues + dequeues FIFO (oldest first) and counts', async () => {
    const s = await freshStore();
    expect(await s.countPendingFires('g')).toBe(0);

    await s.enqueuePendingFire('g', {
      orchName: 'first',
      initialInput: 'in-1',
      ownerId: 'alice',
    });
    await s.enqueuePendingFire('g', {
      orchName: 'second',
      initialInput: null,
      ownerId: 'bob',
    });
    await s.enqueuePendingFire('g', {
      orchName: 'third',
      initialInput: 'in-3',
      ownerId: 'system',
    });
    expect(await s.countPendingFires('g')).toBe(3);

    const a = await s.dequeueNextPendingFire('g');
    expect(a).toEqual({ orchName: 'first', initialInput: 'in-1', ownerId: 'alice' });
    const b = await s.dequeueNextPendingFire('g');
    expect(b).toEqual({ orchName: 'second', initialInput: null, ownerId: 'bob' });
    expect(await s.countPendingFires('g')).toBe(1);

    const c = await s.dequeueNextPendingFire('g');
    expect(c?.orchName).toBe('third');
    expect(await s.dequeueNextPendingFire('g')).toBeNull();
    expect(await s.countPendingFires('g')).toBe(0);
  });

  it('isolates queues by group', async () => {
    const s = await freshStore();
    await s.enqueuePendingFire('ga', { orchName: 'a1', initialInput: null, ownerId: 's' });
    await s.enqueuePendingFire('gb', { orchName: 'b1', initialInput: null, ownerId: 's' });

    expect(await s.countPendingFires('ga')).toBe(1);
    expect(await s.countPendingFires('gb')).toBe(1);
    expect((await s.dequeueNextPendingFire('ga'))?.orchName).toBe('a1');
    // Draining ga left gb untouched.
    expect(await s.countPendingFires('gb')).toBe(1);
    expect(await s.dequeueNextPendingFire('ga')).toBeNull();
  });
});

// ── concurrencyOf — root reader ───────────────────────────────────────────

describe('concurrencyOf', () => {
  it('returns null when no concurrency block / empty group', () => {
    expect(concurrencyOf({} as Node)).toBeNull();
    expect(concurrencyOf({ concurrency: { group: '' } } as Node)).toBeNull();
    expect(concurrencyOf({ concurrency: { group: '   ' } } as Node)).toBeNull();
  });

  it('defaults policy to queue and passes the group through', () => {
    expect(concurrencyOf({ concurrency: { group: 'staging' } } as Node)).toEqual({
      group: 'staging',
      policy: 'queue',
    });
    expect(DEFAULT_CONCURRENCY_POLICY).toBe('queue');
  });

  it('honors an explicit policy', () => {
    expect(
      concurrencyOf({ concurrency: { group: 'g', policy: 'skip' } } as Node),
    ).toEqual({ group: 'g', policy: 'skip' });
    expect(
      concurrencyOf({ concurrency: { group: 'g', policy: 'cancel-existing' } } as Node),
    ).toEqual({ group: 'g', policy: 'cancel-existing' });
  });
});

// ── decideConcurrency — the pure start-gate decision ──────────────────────

describe('decideConcurrency (pure policy decision)', () => {
  it('starts when the group is free, regardless of policy', () => {
    for (const policy of ['skip', 'queue', 'cancel-existing'] as const) {
      expect(decideConcurrency(policy, [])).toEqual({ action: 'start' });
    }
  });

  it('skip → skip with the (oldest) blocking id', () => {
    expect(decideConcurrency('skip', [{ id: 'busy-1' }, { id: 'busy-2' }])).toEqual({
      action: 'skip',
      blockingId: 'busy-1',
    });
  });

  it('queue → queue with the (oldest) blocking id', () => {
    expect(decideConcurrency('queue', [{ id: 'busy-1' }])).toEqual({
      action: 'queue',
      blockingId: 'busy-1',
    });
  });

  it('cancel-existing → cancel every active run, then start', () => {
    expect(
      decideConcurrency('cancel-existing', [{ id: 'busy-1' }, { id: 'busy-2' }]),
    ).toEqual({ action: 'cancel-existing', cancelIds: ['busy-1', 'busy-2'] });
  });
});

// ── Start-gate decision driven against the REAL store ─────────────────────
//
// Glues the two halves the API wraps in a lock: read the active runs in the
// group from the store, then decide. Proves the skip/queue/cancel branches
// fire for an actually-active run, and that 'queue' parks the fire.

describe('start-gate decision over the store', () => {
  async function gateDecision(
    s: RunStore,
    policy: 'skip' | 'queue' | 'cancel-existing',
    group: string,
  ) {
    const active = await s.findActiveRunsInGroup(group);
    return decideConcurrency(policy, active);
  }

  it('skips when an active run holds the group', async () => {
    const s = await freshStore();
    await seedRun(s, { id: 'holder', status: 'running', concurrencyGroup: 'env' });
    expect(await gateDecision(s, 'skip', 'env')).toEqual({
      action: 'skip',
      blockingId: 'holder',
    });
  });

  it('queues + parks a fire behind an active run', async () => {
    const s = await freshStore();
    await seedRun(s, { id: 'holder', status: 'running', concurrencyGroup: 'env' });
    const decision = await gateDecision(s, 'queue', 'env');
    expect(decision.action).toBe('queue');
    if (decision.action === 'queue') {
      await s.enqueuePendingFire('env', {
        orchName: 'qa',
        initialInput: 'x',
        ownerId: 'system',
      });
    }
    expect(await s.countPendingFires('env')).toBe(1);
  });

  it('decides cancel-existing for the active holder', async () => {
    const s = await freshStore();
    await seedRun(s, { id: 'holder', status: 'running', concurrencyGroup: 'env' });
    expect(await gateDecision(s, 'cancel-existing', 'env')).toEqual({
      action: 'cancel-existing',
      cancelIds: ['holder'],
    });
  });

  it('starts (no contention) once the holder has gone terminal', async () => {
    const s = await freshStore();
    await seedRun(s, { id: 'holder', status: 'done', concurrencyGroup: 'env' });
    expect(await gateDecision(s, 'queue', 'env')).toEqual({ action: 'start' });
  });
});

// ── Terminal drain — a queued fire starts after the holder finishes ───────
//
// Models the buildTerminalHook drain seam with a tiny in-memory firer: when a
// run holding the group reaches a terminal status, the API dequeues ONE parked
// fire and starts it. Here we prove the store/drain wiring: dequeue returns the
// parked fire (which the API hands to fireRun), and only ONE drains per call.

describe('terminal drain releases a queued fire', () => {
  it('dequeues the parked fire so the API can fire it (one per terminal)', async () => {
    const s = await freshStore();
    await s.enqueuePendingFire('env', {
      orchName: 'queued-orch',
      initialInput: 'payload',
      ownerId: 'alice',
    });
    await s.enqueuePendingFire('env', {
      orchName: 'queued-orch-2',
      initialInput: null,
      ownerId: 'bob',
    });

    // Simulate the drain a terminal hook performs.
    const started: string[] = [];
    const drainOne = async (group: string) => {
      const next = await s.dequeueNextPendingFire(group);
      if (next) started.push(next.orchName); // API would call fireRun(next...)
    };

    await drainOne('env'); // holder #1 terminates
    expect(started).toEqual(['queued-orch']);
    expect(await s.countPendingFires('env')).toBe(1); // only ONE drained

    await drainOne('env'); // holder #2 terminates → drains the next
    expect(started).toEqual(['queued-orch', 'queued-orch-2']);
    expect(await s.countPendingFires('env')).toBe(0);

    await drainOne('env'); // nothing left — no-op
    expect(started).toEqual(['queued-orch', 'queued-orch-2']);
  });
});

// ── GroupLock — in-process per-group serialization ────────────────────────

describe('GroupLock', () => {
  it('serializes critical sections for the SAME group (no interleave)', async () => {
    const lock = new GroupLock();
    const events: string[] = [];
    const section = (tag: string) =>
      lock.run('g', async () => {
        events.push(`${tag}:enter`);
        // Yield to the event loop; a non-serialized impl would interleave here.
        await new Promise(r => setTimeout(r, 5));
        events.push(`${tag}:exit`);
      });

    await Promise.all([section('A'), section('B')]);
    // Whichever ran first, each enter is immediately followed by its own exit.
    expect(events).toEqual(['A:enter', 'A:exit', 'B:enter', 'B:exit']);
  });

  it('prevents two same-group fires from both passing a no-active check', async () => {
    const s = await freshStore();
    const lock = new GroupLock();
    // Two near-simultaneous fires for the same group. Each, under the lock,
    // checks for an active run and "creates" one if none — exactly the
    // start-gate's check-and-create. Serialized, the second must SEE the
    // first's run and NOT create a duplicate.
    let created = 0;
    const fire = (id: string) =>
      lock.run('env', async () => {
        const active = await s.findActiveRunsInGroup('env');
        if (active.length > 0) return; // group busy — would skip/queue
        await seedRun(s, { id, status: 'running', concurrencyGroup: 'env' });
        created += 1;
      });

    await Promise.all([fire('fire-1'), fire('fire-2')]);
    expect(created).toBe(1);
    expect((await s.findActiveRunsInGroup('env')).length).toBe(1);
  });

  it('does NOT block different groups against each other', async () => {
    const lock = new GroupLock();
    const order: string[] = [];
    // groupA holds for 20ms; groupB should not wait on it.
    const slowA = lock.run('A', async () => {
      await new Promise(r => setTimeout(r, 20));
      order.push('A');
    });
    const fastB = lock.run('B', async () => {
      order.push('B');
    });
    await Promise.all([slowA, fastB]);
    expect(order).toEqual(['B', 'A']); // B finished without waiting for A
  });

  it('a thrown section does not wedge the group (next call still runs)', async () => {
    const lock = new GroupLock();
    await expect(
      lock.run('g', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // The lock must have released — a subsequent section runs.
    const ran = await lock.run('g', async () => 'ok');
    expect(ran).toBe('ok');
  });
});

describe('a cron must not overlap its own previous run', () => {
  /**
   * THE BUG THIS PINS: the cron task was registered with node-cron's
   * `noOverlap: true`, and the comment beside it claimed that "stops a slow
   * tick from stacking onto its own prior run". It does not. node-cron
   * suppresses a tick only while the previous CALLBACK promise is pending —
   * and that callback just inserts a delivery row and returns in
   * milliseconds, so by the next tick it is long since resolved. The run is
   * created later, by the worker, fire-and-forget.
   *
   * So a `* * * * *` cron on a ten-minute orchestration accumulated roughly
   * ten concurrent runs, each spawning agent subprocesses, and nothing capped
   * it: SAMMY_MAX_QUEUE_DEPTH counts only *pending deliveries*, which drain
   * instantly, and SAMMY_MAX_INFLIGHT_PER_ORCH caps *claimed deliveries*, not
   * live runs. The only real guard was the opt-in `concurrency` block.
   *
   * The guard is now an implicit per-orchestration group for cron fires,
   * defaulting to `skip`.
   */
  const cronOrch = (over: Record<string, unknown> = {}): Node =>
    ({
      name: 'nightly',
      triggers: [{ kind: 'cron', expr: '* * * * *', ...over }],
      phases: [{ name: 'p', code: { source: 'return 1;' } }],
    }) as unknown as Node;

  it('defaults to SKIP — the tick is dropped, the running job continues', () => {
    expect(DEFAULT_CRON_OVERLAP).toBe('skip');
    const conc = effectiveConcurrency(cronOrch(), 'cron');
    expect(conc).toEqual({ group: 'sammy:cron:nightly', policy: 'skip' });
    // With a run already live in that group, the decision is to skip.
    expect(decideConcurrency(conc!.policy, [{ id: 'run-live' }])).toEqual({
      action: 'skip',
      blockingId: 'run-live',
    });
  });

  it('"queue" serializes the ticks instead of dropping them', () => {
    const conc = effectiveConcurrency(cronOrch({ overlap: 'queue' }), 'cron');
    expect(conc!.policy).toBe('queue');
    expect(decideConcurrency(conc!.policy, [{ id: 'run-live' }]).action).toBe('queue');
  });

  it('"allow" restores the old unguarded behaviour, but only on request', () => {
    expect(effectiveConcurrency(cronOrch({ overlap: 'allow' }), 'cron')).toBeNull();
  });

  it('an EXPLICIT concurrency block wins over the implicit group', () => {
    const orch = {
      ...cronOrch(),
      concurrency: { group: 'staging-env', policy: 'cancel-existing' },
    } as unknown as Node;
    expect(effectiveConcurrency(orch, 'cron')).toEqual({
      group: 'staging-env',
      policy: 'cancel-existing',
    });
  });

  it('only CRON fires get the implicit group', () => {
    // A webhook burst is not the same hazard — those fires are externally
    // paced and an author who wants them serialized says so.
    for (const kind of ['webhook', 'events', 'queue', 'deployment', 'manual']) {
      expect(effectiveConcurrency(cronOrch(), kind)).toBeNull();
    }
  });

  it('an orchestration with NO cron trigger never gets a cron group', () => {
    // Guards the obvious misfire: asking for the cron group on a
    // webhook-only orchestration must not invent one.
    const webhookOnly = {
      name: 'hook-only',
      triggers: [{ kind: 'webhook', path: 'h' }],
      phases: [],
    } as unknown as Node;
    expect(cronOverlapOf(webhookOnly)).toBeNull();
    expect(effectiveConcurrency(webhookOnly, 'cron')).toBeNull();
    const noTriggers = { name: 'manual', phases: [] } as unknown as Node;
    expect(cronOverlapOf(noTriggers)).toBeNull();
    expect(effectiveConcurrency(noTriggers, 'cron')).toBeNull();
  });

  it('the implicit group is namespaced so it cannot collide with an author group', () => {
    // An author group is an opaque token; ours is prefixed to stay out of
    // that space.
    const conc = effectiveConcurrency(cronOrch(), 'cron')!;
    expect(conc.group.startsWith('sammy:cron:')).toBe(true);
    expect(concurrencyOf({ concurrency: { group: conc.group } })).toEqual({
      group: conc.group,
      policy: DEFAULT_CONCURRENCY_POLICY,
    });
  });
});

describe('DurableGroupLock — exclusion that survives across processes', () => {
  /**
   * THE GAP THIS CLOSES: the start-gate's atomicity came from `GroupLock`, an
   * IN-MEMORY mutex. Two server processes — or a server plus the standalone
   * worker, which is explicitly a supported deployment and the whole point of
   * running several against one Postgres — could both pass "no active run in
   * this group" at the same instant and both create a run. The store-level
   * check narrows the window; only a durable lock closes it.
   *
   * Driven against the real store, with two lock instances standing in for
   * two processes (distinct `holder`s is exactly what makes them distinct).
   */
  const lockFor = (
    s: SqliteRunStore,
    holder: string,
    opts: Partial<{ ttlMs: number; waitMs: number; retryMs: number }> = {},
  ) =>
    new DurableGroupLock(s, {
      holder,
      ttlMs: opts.ttlMs ?? 10_000,
      // No waiting by default: a test must not sit on a 5s retry budget.
      waitMs: opts.waitMs ?? 0,
      retryMs: opts.retryMs ?? 1,
    });

  it('two processes do not both enter the same group', async () => {
    const s = await freshStore();
    const a = lockFor(s, 'proc-a');
    const b = lockFor(s, 'proc-b');

    const order: string[] = [];
    let releaseA!: () => void;
    const aHeld = new Promise<void>(r => {
      releaseA = r;
    });

    const runA = a.run('g', async () => {
      order.push('a-in');
      await aHeld;
      order.push('a-out');
    });
    // Let A take the lock before B tries.
    await new Promise(r => setImmediate(r));

    // B must NOT get the durable lock while A holds it.
    expect(await s.acquireGroupLock('g', 'proc-b', 10_000)).toBe(false);

    releaseA();
    await runA;
    // Released, so B can have it now.
    expect(await s.acquireGroupLock('g', 'proc-b', 10_000)).toBe(true);
    await b.run('g', async () => {
      order.push('b-in');
    });
    expect(order).toEqual(['a-in', 'a-out', 'b-in']);
  });

  it('releases the lock even when the critical section throws', async () => {
    const s = await freshStore();
    const a = lockFor(s, 'proc-a');
    await expect(
      a.run('g', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // A wedged group would be a worse failure than the race.
    expect(await s.acquireGroupLock('g', 'someone-else', 10_000)).toBe(true);
  });

  it('an EXPIRED lock is reclaimable — a crashed holder cannot wedge a group', async () => {
    // The crash-safety property. A holder that dies never releases, so
    // without a TTL its group would be blocked permanently.
    const s = await freshStore();
    expect(await s.acquireGroupLock('g', 'dead-proc', 50, 1_000)).toBe(true);
    // Still held at t=1040.
    expect(await s.acquireGroupLock('g', 'live-proc', 50, 1_040)).toBe(false);
    // Expired by t=1100.
    expect(await s.acquireGroupLock('g', 'live-proc', 50, 1_100)).toBe(true);
  });

  it('only the HOLDER can release', async () => {
    const s = await freshStore();
    expect(await s.acquireGroupLock('g', 'owner', 10_000)).toBe(true);
    // A process whose own lock expired and was taken by someone else must not
    // be able to release the new holder's.
    await s.releaseGroupLock('g', 'impostor');
    expect(await s.acquireGroupLock('g', 'third', 10_000)).toBe(false);
    await s.releaseGroupLock('g', 'owner');
    expect(await s.acquireGroupLock('g', 'third', 10_000)).toBe(true);
  });

  it('different groups never block each other', async () => {
    const s = await freshStore();
    expect(await s.acquireGroupLock('g1', 'p', 10_000)).toBe(true);
    expect(await s.acquireGroupLock('g2', 'p', 10_000)).toBe(true);
  });

  it('FAILS OPEN rather than blocking a fire forever', async () => {
    // Deliberate, and consistent with the rule the gate already documents:
    // the concurrency layer must never break the start path. A stuck lock row
    // blocking every fire is worse than briefly allowing one overlap.
    const s = await freshStore();
    expect(await s.acquireGroupLock('g', 'stuck-holder', 600_000)).toBe(true);

    const logs: string[] = [];
    const b = new DurableGroupLock(s, {
      holder: 'proc-b',
      waitMs: 10,
      retryMs: 1,
      log: m => logs.push(m),
    });
    let ran = false;
    await b.run('g', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(logs.join('\n')).toMatch(/not acquired|WITHOUT it/);
  });

  it('a store that cannot lock does not break the start path either', async () => {
    const logs: string[] = [];
    const broken = new DurableGroupLock(
      {
        acquireGroupLock: async () => {
          throw new Error('db down');
        },
        releaseGroupLock: async () => {},
      },
      { holder: 'p', waitMs: 0, retryMs: 1, log: m => logs.push(m) },
    );
    let ran = false;
    await broken.run('g', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(logs.join('\n')).toMatch(/db down/);
  });

  it('still serializes within ONE process (the local mutex is kept)', async () => {
    // Same-process contention must not reach the database on every fire.
    const s = await freshStore();
    const one = lockFor(s, 'proc-a');
    const order: string[] = [];
    await Promise.all([
      one.run('g', async () => {
        order.push('1-in');
        await new Promise(r => setTimeout(r, 20));
        order.push('1-out');
      }),
      one.run('g', async () => {
        order.push('2-in');
        order.push('2-out');
      }),
    ]);
    expect(order).toEqual(['1-in', '1-out', '2-in', '2-out']);
  });
});
