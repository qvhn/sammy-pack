/**
 * The worker-only topology must drain its own concurrency queue.
 *
 * `dequeueNextPendingFire` was called from exactly one place — the server's
 * terminal drain. The worker parked `queue` fires through its start-gate but
 * nothing in the worker ever released them: a fire parked behind a
 * worker-executed run waited forever, and so did one parked behind a run the
 * worker's orphan scan reclaimed. Both now drain into the worker's own
 * durable queue, where the next poll fires them through the same gate.
 *
 * Also pinned: the gate's cancel-existing branch mirrors the server's —
 * victims are cancelled through the STORE, outside the lock and awaited — so
 * the new run is created only after the old one's row reads `cancelled`.
 *
 * The gate under test is the real one (`makeDirectRunDelivery` from
 * worker.ts); the holder runs are driven by hand through the run-controller
 * with the worker's terminal hook, which is exactly the path a
 * worker-executed run takes to its terminal.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunStore } from '../src/server/run-store';
import { SqliteRunStore } from '../src/server/db';
import { DeliveryWorker } from '../src/server/delivery-worker';
import { RunPauseRequested } from '../src/llm/executor';
import { startRun, isActive, _resetForTests } from '../src/server/run-controller';
import {
  drainPendingFireToQueue,
  makeWorkerTerminalHook,
} from '../src/server/worker-terminal-hook';
import { effectiveConcurrency } from '../src/server/concurrency-group';
import { makeDirectRunDelivery, scanOrphanedRuns } from '../worker';

const GROUP = 'worker-drain-group';
let tmpRoot: string;
let store: SqliteRunStore;
let seq = 0;
const newDeliveryId = () => `del-${Date.now()}-${(seq++).toString(36)}`;

/** Poll on setImmediate until `cond` holds. */
async function until(cond: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 4_000; i++) {
    if (await cond()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`timeout waiting for ${what}`);
}

const pendingDelivery = async (id: string, body: string): Promise<boolean> =>
  store.recordDelivery({
    id,
    kind: 'webhook',
    name: 'hook',
    orchestrationName: 'q',
    idempotencyKey: `k-${id}`,
    keySource: 'header',
    status: 'pending',
    body,
    ownerId: 'system',
    receivedAt: Date.now(),
  });

/** A holder run driven by hand: parks until `release`, then (after `tail`,
 *  which stands in for an in-flight tool call) ends — through the WORKER's
 *  terminal hook, exactly as a worker-executed run would. */
async function startHolder(
  s: RunStore,
  release: Promise<void>,
  tailMs = 0,
): Promise<string> {
  async function* source(signal: AbortSignal) {
    yield { type: 'run-start', orchestrationName: 'q', ts: 0 };
    yield { type: 'phase-start', phaseName: 'hold', agentPath: 'code', ts: 1 };
    await Promise.race([
      release,
      new Promise<void>(r => signal.addEventListener('abort', () => r(), { once: true })),
    ]);
    if (tailMs > 0) await new Promise(r => setTimeout(r, tailMs));
    yield { type: 'phase-end', phaseName: 'hold', replayKey: 'hold', output: 'held', ts: 2 };
  }
  const { id } = await startRun({
    store: s,
    orchestrationName: 'q',
    concurrencyGroup: GROUP,
    onTerminal: makeWorkerTerminalHook({
      orchName: 'q',
      orch: { name: 'q', concurrency: { group: GROUP, policy: 'queue' } },
      ownerId: 'system',
      store: s,
      examplesDir: path.join(tmpRoot, 'examples'),
      newDeliveryId,
    }),
    buildEventSource: signal => source(signal),
  });
  return id;
}

beforeEach(async () => {
  _resetForTests();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-worker-drain-'));
  await fs.mkdir(path.join(tmpRoot, 'examples'));
  await fs.mkdir(path.join(tmpRoot, 'agents'));
  await fs.writeFile(
    path.join(tmpRoot, 'examples', 'q.json'),
    JSON.stringify({
      name: 'q',
      concurrency: { group: GROUP, policy: 'queue' },
      phases: [{ name: 'p', code: { source: "return 'ok:' + input" } }],
    }),
  );
  await fs.writeFile(
    path.join(tmpRoot, 'examples', 'ce.json'),
    JSON.stringify({
      name: 'ce',
      concurrency: { group: GROUP, policy: 'cancel-existing' },
      phases: [{ name: 'p', code: { source: "return 'ce:' + input" } }],
    }),
  );
  store = new SqliteRunStore(tmpRoot);
  await store.init();
});

afterEach(async () => {
  _resetForTests();
  await store.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('worker-only lifecycle: a parked fire is released by the worker itself', () => {
  it('holder finishes in the worker → the parked fire runs through the worker queue', async () => {
    const worker = new DeliveryWorker({
      store,
      runDelivery: makeDirectRunDelivery({ store, root: tmpRoot, newDeliveryId }),
    });
    let release!: () => void;
    const held = new Promise<void>(r => {
      release = r;
    });
    const holder = await startHolder(store, held);
    expect((await store.findActiveRunsInGroup(GROUP)).map(r => r.id)).toEqual([holder]);

    // The REAL gate parks the second fire behind the holder.
    await pendingDelivery('d-parked', 'B');
    expect((await worker.processOne())?.id).toBe('d-parked');
    expect((await store.listDeliveries(10)).find(d => d.id === 'd-parked')?.status).toBe(
      'deferred',
    );
    expect(await store.countPendingFires(GROUP)).toBe(1);

    // The holder terminates through the worker's hook (which fires after the
    // run leaves the active map) …
    release();
    await until(async () => !isActive(holder), 'the holder to finish');
    expect((await store.getRun(holder))?.status).toBe('done');
    // … which released the parked fire INTO THE QUEUE, not into thin air.
    await until(
      async () => (await store.countPendingFires(GROUP)) === 0,
      'the terminal hook to drain the group',
    );
    const drained = (await store.listDeliveries(10)).find(d => d.kind === 'concurrency-drain');
    expect(drained).toMatchObject({ orchestrationName: 'q', body: 'B', status: 'pending' });

    // The next poll fires it through the gate; the group is free, so it runs.
    expect((await worker.processOne())?.id).toBe(drained?.id);
    const fired = (await store.listDeliveries(10)).find(d => d.id === drained?.id);
    expect(fired?.status).toBe('fired');
    await until(
      async () => (await store.getRun(fired!.runId!))?.status === 'done',
      'the drained run to finish',
    );
    expect((await store.getRun(fired!.runId!))?.lastOutput).toBe('ok:B');
    expect((await store.getRun(fired!.runId!))?.concurrencyGroup).toBe(GROUP);
    // Let the drained run's own (empty) terminal drain settle before the
    // store closes.
    await new Promise(r => setTimeout(r, 100));
  }, 15_000);

  it("the orphan scan drains a reclaimed run's group the same way", async () => {
    // A worker died holding the group with a fire parked behind it. The
    // surviving worker's scan reclaims the run as `interrupted` — which
    // releases the group — but nothing ever re-drove the fire.
    await store.upsertRun({
      id: 'dead-holder',
      orchestrationName: 'q',
      startedAt: Date.now() - 1_000,
      status: 'running',
      events: [{ type: 'run-start', ts: 0 }],
      concurrencyGroup: GROUP,
    });
    await store.enqueuePendingFire(GROUP, { orchName: 'q', initialInput: 'C', ownerId: 'system' });
    // The lease belongs to a dead peer: reclaim from a fresh instance id.
    const survivor = new SqliteRunStore(tmpRoot, { instanceId: 'survivor' });
    await survivor.init();
    try {
      // Push "now" past the holder's lease so the scan treats it as expired.
      // (The drained delivery is stamped with this clock too, so the worker
      // below reads the same one — otherwise it is not yet claimable.)
      const realNow = Date.now;
      const later = () => realNow() + 10 * 60_000;
      Date.now = later;
      try {
        await scanOrphanedRuns(survivor, newDeliveryId, 'test');
      } finally {
        Date.now = realNow;
      }
      expect((await survivor.getRun('dead-holder'))?.status).toBe('interrupted');
      expect(await survivor.countPendingFires(GROUP)).toBe(0);
      const drained = (await survivor.listDeliveries(10)).find(
        d => d.kind === 'concurrency-drain',
      );
      expect(drained).toMatchObject({ orchestrationName: 'q', body: 'C', status: 'pending' });

      const worker = new DeliveryWorker({
        store: survivor,
        now: later,
        runDelivery: makeDirectRunDelivery({ store: survivor, root: tmpRoot, newDeliveryId }),
      });
      expect((await worker.processOne())?.id).toBe(drained?.id);
      const fired = (await survivor.listDeliveries(10)).find(d => d.id === drained?.id);
      expect(fired?.status).toBe('fired');
      await until(
        async () => (await survivor.getRun(fired!.runId!))?.status === 'done',
        'the drained run to finish',
      );
      expect((await survivor.getRun(fired!.runId!))?.lastOutput).toBe('ok:C');
      await new Promise(r => setTimeout(r, 100));
    } finally {
      await survivor.close();
    }
  }, 15_000);

  it("a leg that could not record its terminal is reclaimed by THIS worker's own scan, and its group drains", async () => {
    // Three failed status writes (the real 250/500ms backoff) and the leg
    // gives up: row `running` under this process's OWN lease, controller
    // gone. A lone worker has no peer to reclaim it, and the scan's own-row
    // exclusion used to protect it forever — group held, fires parked for
    // good.
    const failing = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === 'updateRunStatus') {
          return async (id: string, patch: { status?: string }, o?: unknown) => {
            if (patch.status === 'done') throw new Error('SQLITE_BUSY: database is locked');
            return target.updateRunStatus(id, patch as never, o as never);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as SqliteRunStore;
    let release!: () => void;
    const held = new Promise<void>(r => {
      release = r;
    });
    const holder = await startHolder(failing, held);
    release();
    await until(async () => !isActive(holder), 'the leg to give up');
    await new Promise(r => setTimeout(r, 50)); // let the (empty) terminal drain settle
    expect((await store.getRun(holder))?.status).toBe('running');
    // A fire arrives behind the abandoned row: parked, since the row still
    // counts as active in its group.
    await store.enqueuePendingFire(GROUP, {
      orchName: 'q',
      initialInput: 'behind-the-dead',
      ownerId: 'system',
    });
    expect((await store.findActiveRunsInGroup(GROUP)).map(r => r.id)).toEqual([holder]);

    // Once the lease lapses the worker's own scan reclaims it — same store,
    // same instance id — and drains the group as it does for a dead peer's.
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60_000;
    try {
      await scanOrphanedRuns(store, newDeliveryId, 'test');
    } finally {
      Date.now = realNow;
    }
    expect((await store.getRun(holder))?.status).toBe('interrupted');
    expect(await store.findActiveRunsInGroup(GROUP)).toEqual([]);
    expect(await store.countPendingFires(GROUP)).toBe(0);
    expect(
      (await store.listDeliveries(10)).find(d => d.kind === 'concurrency-drain'),
    ).toMatchObject({ orchestrationName: 'q', body: 'behind-the-dead', status: 'pending' });
  }, 15_000);

  it('a holder that PAUSES keeps its group: the parked fire stays parked', async () => {
    // `paused` still holds the group (findActiveRunsInGroup counts it). A
    // drain on that terminal would hatch the parked fire into a busy group —
    // re-parked under `queue` (two rows for one fire), dropped under `skip`.
    async function* pausing() {
      yield { type: 'run-start', orchestrationName: 'q', ts: 0 };
      yield { type: 'phase-start', phaseName: 'hold', agentPath: 'code', ts: 1 };
      throw new RunPauseRequested('hold');
    }
    await store.enqueuePendingFire(GROUP, { orchName: 'q', initialInput: 'parked', ownerId: 'system' });
    const { id } = await startRun({
      store,
      orchestrationName: 'q',
      concurrencyGroup: GROUP,
      onTerminal: makeWorkerTerminalHook({
        orchName: 'q',
        orch: { name: 'q', concurrency: { group: GROUP, policy: 'queue' } },
        ownerId: 'system',
        store,
        examplesDir: path.join(tmpRoot, 'examples'),
        newDeliveryId,
      }),
      buildEventSource: () => pausing(),
    });
    await until(async () => !isActive(id), 'the holder to pause');
    await new Promise(r => setTimeout(r, 50)); // the hook fires after the leg leaves the active map
    expect((await store.getRun(id))?.status).toBe('paused');
    expect((await store.findActiveRunsInGroup(GROUP)).map(r => r.id)).toEqual([id]);
    expect(await store.countPendingFires(GROUP)).toBe(1);
    expect((await store.listDeliveries(10)).filter(d => d.kind === 'concurrency-drain')).toEqual([]);
  });

  it('the drain KIND is part of the gate decision, not a label', async () => {
    // Pins what `drainPendingFireToQueue`'s comment asserts about the kind it
    // records under (it claimed the opposite): an explicit root `concurrency`
    // block survives any kind, but the implicit per-orchestration cron group
    // is derived ONLY for kind `cron` — so a fire parked under one and
    // re-driven as `concurrency-drain` re-enters with no group at all. The
    // server's drain path has the same rule; it applies to this half too.
    const cronOrch = {
      name: 'cronq',
      triggers: [{ kind: 'cron' as const, expr: '0 0 1 1 *', overlap: 'queue' as const }],
    };
    expect(effectiveConcurrency(cronOrch, 'cron')).toEqual({
      group: 'sammy:cron:cronq',
      policy: 'queue',
    });
    expect(effectiveConcurrency(cronOrch, 'concurrency-drain')).toBeNull();
    const explicitOrch = {
      name: 'expq',
      concurrency: { group: 'expq-g', policy: 'queue' as const },
    };
    expect(effectiveConcurrency(explicitOrch, 'concurrency-drain')).toMatchObject({
      group: 'expq-g',
    });
  });

  it('a drain whose delivery cannot be recorded RE-PARKS the fire instead of losing it', async () => {
    // dequeueNextPendingFire has already DELETED the row by the time
    // recordDelivery runs: a hiccup there was the one place a parked fire
    // could silently vanish.
    await store.enqueuePendingFire(GROUP, { orchName: 'q', initialInput: 'fragile', ownerId: 'system' });
    let refusals = 1;
    const flaky = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === 'recordDelivery') {
          return async (input: unknown) =>
            refusals-- > 0 ? false : target.recordDelivery(input as never);
        }
        return Reflect.get(target, prop, recv);
      },
    }) as SqliteRunStore;
    const log: string[] = [];
    expect(await drainPendingFireToQueue(flaky, GROUP, newDeliveryId, m => log.push(m))).toBeNull();
    expect(log.join('\n')).toMatch(/RE-PARKED/);
    expect(await store.countPendingFires(GROUP)).toBe(1);
    expect((await store.listDeliveries(10)).filter(d => d.kind === 'concurrency-drain')).toEqual([]);
    // The next drain finds it exactly where it was left.
    const id = await drainPendingFireToQueue(flaky, GROUP, newDeliveryId, m => log.push(m));
    expect(id).toBeTruthy();
    expect(await store.countPendingFires(GROUP)).toBe(0);
    expect((await store.listDeliveries(10)).find(d => d.id === id)).toMatchObject({
      orchestrationName: 'q',
      body: 'fragile',
      status: 'pending',
    });
  });
});

describe('worker cancel-existing: decide under the lock, cancel through the store outside it', () => {
  it('the victim reads cancelled BEFORE the new run exists, and a parked fire is not stranded', async () => {
    // Record the order of the store writes that matter: the victim's
    // cancelled flip vs. the new run's insert. The old gate aborted a LOCAL
    // victim in memory and created the new run at once — while the victim
    // was still `running` and its agent subprocesses still alive.
    const order: string[] = [];
    let victim = '';
    let victimAliveAtInsert: boolean | null = null;
    const observed = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === 'updateRunStatus') {
          return async (id: string, patch: { status?: string }, o?: unknown) => {
            if (patch.status !== 'cancelled') {
              return target.updateRunStatus(id, patch as never, o as never);
            }
            // A store round trip (Postgres), not SQLite's same-tick body: a
            // cancel the gate did not AWAIT would let it re-decide — and
            // insert the new run — before this flip has landed.
            await new Promise(r => setTimeout(r, 20));
            const res = await target.updateRunStatus(id, patch as never, o as never);
            order.push(`cancel:${id}`);
            return res;
          };
        }
        if (prop === 'upsertRun') {
          return async (run: { id: string; orchestrationName: string }) => {
            order.push(`insert:${run.id}`);
            // The server's seam waits for a local victim to unwind before
            // the new run exists; the worker's used to insert at once.
            if (run.orchestrationName === 'ce') victimAliveAtInsert = isActive(victim);
            return target.upsertRun(run as never);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as SqliteRunStore;

    // A holder wedged on an in-flight tool: it ignores the release and takes
    // 200ms to unwind after the abort.
    victim = await startHolder(observed, new Promise<void>(() => {}), 200);
    await store.enqueuePendingFire(GROUP, { orchName: 'q', initialInput: 'parked', ownerId: 'system' });

    const worker = new DeliveryWorker({
      store: observed,
      runDelivery: makeDirectRunDelivery({ store: observed, root: tmpRoot, newDeliveryId }),
    });
    await store.recordDelivery({
      id: 'd-ce',
      kind: 'webhook',
      name: 'hook',
      orchestrationName: 'ce',
      idempotencyKey: 'k-ce',
      keySource: 'header',
      status: 'pending',
      body: 'new',
      ownerId: 'system',
      receivedAt: Date.now(),
    });
    const warn = jest.spyOn(console, 'warn');
    // Must settle (no deadlock between the gate's lock and the drain) …
    expect((await worker.processOne())?.id).toBe('d-ce');
    warn.mockRestore();
    const fired = (await store.listDeliveries(10)).find(d => d.id === 'd-ce');
    expect(fired?.status).toBe('fired');
    const newRun = fired!.runId!;

    // … with the victim flipped in the store BEFORE the new run was inserted
    // — because the cancel was awaited, not because the gate gave up on it.
    expect(order.indexOf(`cancel:${victim}`)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(`cancel:${victim}`)).toBeLessThan(order.indexOf(`insert:${newRun}`));
    expect(warn.mock.calls.map(c => c.join(' ')).join('\n')).not.toMatch(
      /still active after \d+ cancel passes/,
    );
    expect((await store.getRun(victim))?.status).toBe('cancelled');
    // … and its executor already unwound: no agent subprocess of the old
    // run outlives the moment the new one exists.
    expect(victimAliveAtInsert).toBe(false);

    // The victim's parked fire was released into the queue, not stranded.
    expect(await store.countPendingFires(GROUP)).toBe(0);
    expect(
      (await store.listDeliveries(10)).find(d => d.kind === 'concurrency-drain'),
    ).toMatchObject({ orchestrationName: 'q', body: 'parked', status: 'pending' });

    await until(async () => !isActive(victim) && !isActive(newRun), 'both legs to settle');
    expect((await store.getRun(victim))?.status).toBe('cancelled');
    expect((await store.getRun(newRun))?.status).toBe('done');
    expect((await store.getRun(newRun))?.lastOutput).toBe('ce:new');
    await new Promise(r => setTimeout(r, 100));
  }, 15_000);

  it('a LOCAL victim that unwound gets exactly ONE run-cancelled sentinel', async () => {
    // A real executor's unwind YIELDS its own `run-cancelled`, which the
    // controller persists (the append fence only guards `running` rows). The
    // gate appended its own on top unconditionally, so one cancel left TWO
    // sentinels in the victim's durable log — and the bounded unwind wait
    // makes that deterministic rather than racy, because it guarantees the
    // victim's own has landed before the gate moves on. The server seam
    // already takes the sentinel only when the victim wrote none.
    async function* unwinds(signal: AbortSignal) {
      yield { type: 'run-start', orchestrationName: 'q', ts: 0 };
      yield { type: 'phase-start', phaseName: 'hold', agentPath: 'code', ts: 1 };
      await new Promise<void>(r =>
        signal.addEventListener('abort', () => r(), { once: true }),
      );
      // Mirrors the executor's own cancel sentinel.
      yield { type: 'run-cancelled', ts: Date.now() };
    }
    const { id: victim } = await startRun({
      store,
      orchestrationName: 'q',
      concurrencyGroup: GROUP,
      onTerminal: makeWorkerTerminalHook({
        orchName: 'q',
        orch: { name: 'q', concurrency: { group: GROUP, policy: 'queue' } },
        ownerId: 'system',
        store,
        examplesDir: path.join(tmpRoot, 'examples'),
        newDeliveryId,
      }),
      buildEventSource: signal => unwinds(signal),
    });

    const worker = new DeliveryWorker({
      store,
      runDelivery: makeDirectRunDelivery({ store, root: tmpRoot, newDeliveryId }),
    });
    await store.recordDelivery({
      id: 'd-ce-1',
      kind: 'webhook',
      name: 'hook',
      orchestrationName: 'ce',
      idempotencyKey: 'k-ce-1',
      keySource: 'header',
      status: 'pending',
      body: 'new',
      ownerId: 'system',
      receivedAt: Date.now(),
    });
    expect((await worker.processOne())?.id).toBe('d-ce-1');

    const run = await store.getRun(victim);
    expect(run?.status).toBe('cancelled');
    expect(run?.events.filter(e => e.type === 'run-cancelled')).toHaveLength(1);
    await until(async () => !isActive(victim), 'the victim leg to settle');
    expect(
      (await store.getRun(victim))?.events.filter(e => e.type === 'run-cancelled'),
    ).toHaveLength(1);
    await new Promise(r => setTimeout(r, 100));
  }, 15_000);

  it('a LOCAL victim still wedged PAST the 5 s bound gets exactly ONE too', async () => {
    // The bound exists for a leg wedged on an in-flight tool call, so this
    // is the documented case, not an exotic one — and reading "no sentinel
    // yet" as "none will land" made the duplicate DETERMINISTIC here: the
    // victim is still executing, so its own `run-cancelled` is still to
    // come, and the append fence passes it (the row is already `cancelled`).
    // After the A2A mapping each sentinel is its own `canceled` FINAL status
    // update, so one cancel reported two finals for one task.
    async function* wedged(signal: AbortSignal) {
      yield { type: 'run-start', orchestrationName: 'q', ts: 0 };
      yield { type: 'phase-start', phaseName: 'hold', agentPath: 'code', ts: 1 };
      await new Promise<void>(r =>
        signal.addEventListener('abort', () => r(), { once: true }),
      );
      // Past the gate's bound before yielding the executor's own sentinel.
      await new Promise(r => setTimeout(r, 6_500));
      yield { type: 'run-cancelled', ts: Date.now() };
    }
    const { id: victim } = await startRun({
      store,
      orchestrationName: 'q',
      concurrencyGroup: GROUP,
      onTerminal: makeWorkerTerminalHook({
        orchName: 'q',
        orch: { name: 'q', concurrency: { group: GROUP, policy: 'queue' } },
        ownerId: 'system',
        store,
        examplesDir: path.join(tmpRoot, 'examples'),
        newDeliveryId,
      }),
      buildEventSource: signal => wedged(signal),
    });

    const worker = new DeliveryWorker({
      store,
      runDelivery: makeDirectRunDelivery({ store, root: tmpRoot, newDeliveryId }),
    });
    await store.recordDelivery({
      id: 'd-ce-2',
      kind: 'webhook',
      name: 'hook',
      orchestrationName: 'ce',
      idempotencyKey: 'k-ce-2',
      keySource: 'header',
      status: 'pending',
      body: 'new',
      ownerId: 'system',
      receivedAt: Date.now(),
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await worker.processOne())?.id).toBe('d-ce-2');
    // The bound really did lapse — otherwise this is the sibling case above.
    expect(warn.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(
      /had not unwound within 5000ms/,
    );
    warn.mockRestore();

    // At the gate: none yet, because the victim owns it.
    expect(
      (await store.getRun(victim))?.events.filter(e => e.type === 'run-cancelled'),
    ).toHaveLength(0);
    // And after it finally unwinds: exactly its own, never two.
    await until(async () => !isActive(victim), 'the wedged victim to settle');
    const run = await store.getRun(victim);
    expect(run?.status).toBe('cancelled');
    expect(run?.events.filter(e => e.type === 'run-cancelled')).toHaveLength(1);
    await new Promise(r => setTimeout(r, 100));
  }, 30_000);
});

describe('a DRAINED fire holds the group it was parked under', () => {
  // `effectiveConcurrency` derives the implicit `sammy:cron:<name>` group
  // only for kind `cron`, and a drain fires kind `concurrency-drain` — so
  // the drained run used to be created with NO group. That is a liveness
  // defect, not only an overlap one: its own terminal read a null group and
  // drained nothing, so the backlog advanced by at most one fire per later
  // cron tick and not at all once ticks stopped (trigger edited away,
  // orchestration deleted, breaker auto-pause), with `/api/concurrency`
  // reporting `held: false` beside a non-empty `queued`. The server's half
  // threads the group through as `knownGroup`; this is the worker's.
  const CRON_GROUP = 'sammy:cron:implicit';

  beforeEach(async () => {
    await fs.writeFile(
      path.join(tmpRoot, 'examples', 'implicit.json'),
      JSON.stringify({
        name: 'implicit',
        // NO root `concurrency` block: the group exists only because a cron
        // trigger fires it.
        phases: [{ name: 'p', code: { source: "return 'imp:' + input" } }],
      }),
    );
  });

  it('stamps the group on the drained run, so its own terminal advances the queue', async () => {
    const worker = new DeliveryWorker({
      store,
      runDelivery: makeDirectRunDelivery({ store, root: tmpRoot, newDeliveryId }),
    });
    // The row a drain writes: kind `concurrency-drain`, `name` = the group.
    await store.recordDelivery({
      id: 'd-drain-1',
      kind: 'concurrency-drain',
      name: CRON_GROUP,
      orchestrationName: 'implicit',
      idempotencyKey: 'auto:drain:d-drain-1',
      keySource: 'auto',
      status: 'pending',
      body: 'A',
      ownerId: 'system',
      receivedAt: Date.now(),
    });
    // A second fire already parked behind it.
    await store.enqueuePendingFire(CRON_GROUP, {
      orchName: 'implicit',
      initialInput: 'B',
      ownerId: 'system',
    });

    expect((await worker.processOne())?.id).toBe('d-drain-1');
    const fired = (await store.listDeliveries(10)).find(d => d.id === 'd-drain-1');
    expect(fired?.status).toBe('fired');
    const runId = fired!.runId!;
    // A real holder: visible to the gate, so the next cron tick parks …
    expect((await store.getRun(runId))?.concurrencyGroup).toBe(CRON_GROUP);
    await until(
      async () => (await store.getRun(runId))?.status === 'done',
      'the drained run to finish',
    );
    // … and able to release the fire behind it at its own terminal.
    await until(
      async () => (await store.countPendingFires(CRON_GROUP)) === 0,
      'the drained run to drain the queue behind it',
    );
    expect(
      (await store.listDeliveries(10)).filter(d => d.kind === 'concurrency-drain').length,
    ).toBe(2);
    await new Promise(r => setTimeout(r, 100));
  }, 15_000);

  it('leaves an ordinary (non-drain) ungated fire with no group', async () => {
    // Only a drain carries a group on `name`; a plain webhook's `name` is
    // the hook's, which must never be read as a concurrency group.
    const worker = new DeliveryWorker({
      store,
      runDelivery: makeDirectRunDelivery({ store, root: tmpRoot, newDeliveryId }),
    });
    await store.recordDelivery({
      id: 'd-plain-1',
      kind: 'webhook',
      name: 'hook',
      orchestrationName: 'implicit',
      idempotencyKey: 'k-plain-1',
      keySource: 'header',
      status: 'pending',
      body: 'A',
      ownerId: 'system',
      receivedAt: Date.now(),
    });
    expect((await worker.processOne())?.id).toBe('d-plain-1');
    const fired = (await store.listDeliveries(10)).find(d => d.id === 'd-plain-1');
    expect((await store.getRun(fired!.runId!))?.concurrencyGroup).toBeFalsy();
    await until(
      async () => (await store.getRun(fired!.runId!))?.status === 'done',
      'the plain run to finish',
    );
    await new Promise(r => setTimeout(r, 100));
  }, 15_000);
});

describe('worker: a late concurrency-drain delivery re-checks its group', () => {
  it('parks behind a holder that took the group meanwhile instead of overlapping it', async () => {
    await fs.writeFile(
      path.join(tmpRoot, 'examples', 'late.json'),
      JSON.stringify({ name: 'late', phases: [{ name: 'p', code: { source: "return 'ran'" } }] }),
    );
    const group = 'sammy:cron:late';
    await store.upsertRun({
      id: 'newer-holder',
      orchestrationName: 'late',
      startedAt: Date.now(),
      status: 'paused',
      events: [],
      concurrencyGroup: group,
    });
    await store.recordDelivery({
      id: 'late-drain',
      kind: 'concurrency-drain',
      name: group,
      orchestrationName: 'late',
      idempotencyKey: 'drain:late-w',
      keySource: 'auto',
      status: 'pending',
      body: 'x',
      ownerId: 'system',
      receivedAt: Date.now(),
    });
    const worker = new DeliveryWorker({
      store,
      runDelivery: makeDirectRunDelivery({ store, root: tmpRoot, newDeliveryId }),
    });
    await worker.processOne();
    const d = (await store.listDeliveries(20)).find(x => x.id === 'late-drain');
    expect(d?.status).toBe('deferred');
    expect(await store.countPendingFires(group)).toBe(1);
    const others = (await store.listRuns()).filter(r => r.orchestrationName === 'late' && r.id !== 'newer-holder');
    expect(others).toHaveLength(0);
  });
});
