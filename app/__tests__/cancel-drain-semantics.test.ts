/**
 * Cancel semantics for concurrency queues — pins the drain-on-cancel
 * contract end to end over the mounted API:
 *
 *   1. Cancelling the HOLDER of a group STARTS the next queued fire as a
 *      real run (the intended one-drain-per-terminal behavior).
 *   2. Duplicate / racing cancels of the SAME holder (a double-clicked Stop,
 *      the Runs view's bulk-stop Promise.all racing a single Stop) collapse
 *      to ONE terminal — ONE drain, ONE run-cancelled sentinel — instead of
 *      each racer draining another parked fire. This was a real
 *      check-then-write race in the store-path cancel (both racers could
 *      read `paused` before either wrote `cancelled`); it is now serialized
 *      per run id (cancelStoredRunAndDrain), which these tests would catch
 *      regressing.
 *   3. Cancelling an ALREADY-cancelled run is a no-op — it must never drain
 *      (resurrect) more queued work.
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

describe('cancel → drain semantics', () => {
  let server: http.Server;
  let tmpRoot: string;
  let baseUrl: string;
  let store: SqliteRunStore;
  const prevWorker = process.env.SAMMY_DISABLE_INPROCESS_WORKER;
  const prevDbUrl = process.env.DATABASE_URL;

  beforeEach(async () => {
    process.env.SAMMY_DISABLE_INPROCESS_WORKER = '1';
    delete process.env.DATABASE_URL;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-cancel-'));
    // A REAL no-LLM orchestration for queued fires that should actually
    // start: one code.source phase, same group as the holders. Executes
    // fully in-process (no agent / SDK), finishing 'done' in milliseconds.
    await fs.mkdir(path.join(tmpRoot, 'examples'), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'examples', 'queued-orch.json'),
      JSON.stringify({
        name: 'queued-orch',
        concurrency: { group: 'g1', policy: 'queue' },
        phases: [{ name: 'p', code: { source: "return 'ran'" } }],
      }),
      'utf8',
    );
    // Drainable: no concurrency block, so a drained fire starts immediately.
    // The racing tests below park THESE rather than orchestrations missing
    // from the workspace — a fire whose start refuses transiently is now
    // RE-PARKED rather than discarded (it used to be silently destroyed), so
    // a missing orchestration would leave the pending count unchanged and no
    // longer distinguish one drain from two.
    //
    // It PAUSES at a locked phase rather than finishing in milliseconds,
    // because the drained run now holds the group it was drained from (so its
    // own terminal drains the next fire — the fix for a backlog that advanced
    // only when a later grouped fire happened to terminate). A run that
    // finished instantly would chain through the whole queue, and the pending
    // count could no longer tell one drain from two. Paused counts as active,
    // so the drained run holds the group and the remainder stays parked —
    // which is exactly the per-terminal contract these cases pin.
    await fs.writeFile(
      path.join(tmpRoot, 'examples', 'drainable-orch.json'),
      JSON.stringify({
        name: 'drainable-orch',
        phases: [
          { name: 'p', code: { source: "return 'drained'" }, lock: true },
        ],
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
    if (prevWorker === undefined) delete process.env.SAMMY_DISABLE_INPROCESS_WORKER;
    else process.env.SAMMY_DISABLE_INPROCESS_WORKER = prevWorker;
    if (prevDbUrl !== undefined) process.env.DATABASE_URL = prevDbUrl;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  /** A paused holder of `group` — paused counts as active (holds the group)
   *  and has no live in-process controller, so /cancel takes the store path
   *  (exactly the state whose queue used to strand / double-drain). */
  async function seedPausedHolder(id: string, group: string): Promise<void> {
    await store.upsertRun({
      id,
      orchestrationName: 'holder-orch',
      startedAt: Date.now() - 1_000,
      status: 'running',
      events: [],
      concurrencyGroup: group,
    });
    await store.updateRunStatus(id, {
      status: 'paused',
      pausedFor: 'review-gate',
    });
  }

  async function cancelRun(id: string): Promise<{
    status: number;
    body: Record<string, unknown>;
  }> {
    const res = await fetch(`${baseUrl}/api/runs/${id}/cancel`, {
      method: 'POST',
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function until<T>(probe: () => Promise<T | false>): Promise<T> {
    for (let i = 0; i < 150; i += 1) {
      const v = await probe();
      if (v) return v;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('condition not reached');
  }

  it('cancelling the holder starts the next queued run (and only that one)', async () => {
    await seedPausedHolder('holder-1', 'g1');
    await store.enqueuePendingFire('g1', {
      orchName: 'queued-orch',
      initialInput: 'payload',
      ownerId: 'system',
    });

    const out = await cancelRun('holder-1');
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, cancelled: true });

    // The parked fire was dequeued AND actually started: a real queued-orch
    // run appears and finishes 'done' with the code phase's output.
    const queuedRun = await until(async () => {
      const runs = await store.listRuns(50);
      const r = runs.find(
        x => x.orchestrationName === 'queued-orch' && x.status === 'done',
      );
      return r ?? false;
    });
    expect(queuedRun.lastOutput).toBe('ran');
    expect(await store.countPendingFires('g1')).toBe(0);

    // Re-cancelling the (already cancelled) holder must NOT resurrect
    // anything: no drain, no new runs, the same single sentinel.
    const again = await cancelRun('holder-1');
    expect(again.body).toMatchObject({ ok: false, status: 'cancelled' });
    const queuedRuns = (await store.listRuns(50)).filter(
      r => r.orchestrationName === 'queued-orch',
    );
    expect(queuedRuns).toHaveLength(1);
    const holder = await store.getRun('holder-1');
    expect(
      holder!.events.filter(e => e.type === 'run-cancelled'),
    ).toHaveLength(1);
  });

  it('racing duplicate cancels drain exactly ONE parked fire (bulk-stop class)', async () => {
    await seedPausedHolder('holder-2', 'g2');
    // Two fires parked behind the holder, both for a DRAINABLE orchestration
    // so each drain genuinely consumes one: the count dropping by exactly one
    // is what proves a single terminal performed a single drain, however many
    // cancels race.
    await store.enqueuePendingFire('g2', {
      orchName: 'drainable-orch',
      initialInput: null,
      ownerId: 'system',
    });
    await store.enqueuePendingFire('g2', {
      orchName: 'drainable-orch',
      initialInput: null,
      ownerId: 'system',
    });

    // The bulk-stop shape: near-simultaneous cancels of the same run.
    const [a, b] = await Promise.all([
      cancelRun('holder-2'),
      cancelRun('holder-2'),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Exactly one racer performed the cancel; the other observed it done.
    const winners = [a.body, b.body].filter(x => x.ok === true);
    expect(winners).toHaveLength(1);

    // ONE terminal → ONE drain: one fire consumed, one still parked, one
    // sentinel. (Pre-serialization, both racers could read `paused` and
    // each drain a fire — 2 → 0 — resurrecting work mid-shutdown.)
    expect(await store.countPendingFires('g2')).toBe(1);
    const holder = await store.getRun('holder-2');
    expect(holder!.status).toBe('cancelled');
    expect(
      holder!.events.filter(e => e.type === 'run-cancelled'),
    ).toHaveLength(1);
  });

  it('gate-reject racing /cancel also collapses to one terminal + one drain', async () => {
    await seedPausedHolder('holder-3', 'g3');
    await store.enqueuePendingFire('g3', {
      orchName: 'drainable-orch',
      initialInput: null,
      ownerId: 'system',
    });
    await store.enqueuePendingFire('g3', {
      orchName: 'drainable-orch',
      initialInput: null,
      ownerId: 'system',
    });

    const reject = fetch(`${baseUrl}/api/runs/holder-3/gate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'reject' }),
    });
    const [rejectRes, cancelRes] = await Promise.all([
      reject,
      fetch(`${baseUrl}/api/runs/holder-3/cancel`, { method: 'POST' }),
    ]);
    // The /cancel path always reports the (idempotent) outcome; the gate
    // path may instead 409 at its own "still paused?" entry check when the
    // cancel wins first — either response is fine. What must NOT vary is
    // the store: one terminal, one drain, one sentinel (asserted below).
    expect(cancelRes.status).toBe(200);
    expect([200, 409]).toContain(rejectRes.status);

    expect(await store.countPendingFires('g3')).toBe(1); // one drain only
    const holder = await store.getRun('holder-3');
    expect(holder!.status).toBe('cancelled');
    expect(
      holder!.events.filter(e => e.type === 'run-cancelled'),
    ).toHaveLength(1);
  });
});
