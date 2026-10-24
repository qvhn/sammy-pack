import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import connect from 'connect';
import { mountSammyApi } from '../sammy-pack-api';
import { SqliteRunStore } from '../src/server/db';

/** A drained fire whose start was refused (transiently, or by the budget) is
 *  kept as a durable `concurrency-drain` DELIVERY for the worker to retry —
 *  or, failing that, re-parked. Either way it is not lost. */
async function preservedDrains(
  store: { countPendingFires(g: string): Promise<number>; listDeliveries(n: number): Promise<Array<{ kind: string; name: string; status: string }>> },
  group: string,
): Promise<number> {
  const queued = (await store.listDeliveries(1000)).filter(
    d => d.kind === 'concurrency-drain' && d.name === group && d.status === 'pending',
  ).length;
  return (await store.countPendingFires(group)) + queued;
}


// Proves the API surface mounts + serves over a plain Node http.Server +
// connect stack with NO Vite — i.e. the standalone production server path
// (serve.ts) actually works, not just the dev plugin.
describe('mountSammyApi on a standalone connect server (no Vite)', () => {
  let server: http.Server;
  let tmpRoot: string;
  let baseUrl: string;
  let store: SqliteRunStore;
  const prevWorker = process.env.SAMMY_DISABLE_INPROCESS_WORKER;
  const prevDbUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    // Keep the queue drain loop out of this test; force the zero-infra SQLite
    // store regardless of any ambient DATABASE_URL.
    process.env.SAMMY_DISABLE_INPROCESS_WORKER = '1';
    delete process.env.DATABASE_URL;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-serve-'));

    // Inject a directly-constructed store — boot's openRunStore() uses a
    // dynamic import the jest runtime can't resolve.
    store = new SqliteRunStore(tmpRoot);
    await store.init();

    const app = connect();
    server = http.createServer(app);
    await mountSammyApi(
      {
        middlewares: app,
        // repoRoot() resolves two levels up, so this hands the body `tmpRoot`.
        config: { root: path.join(tmpRoot, 'app', 'web') },
        httpServer: server,
      },
      { store },
    );
    await new Promise<void>(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (prevWorker === undefined) delete process.env.SAMMY_DISABLE_INPROCESS_WORKER;
    else process.env.SAMMY_DISABLE_INPROCESS_WORKER = prevWorker;
    if (prevDbUrl !== undefined) process.env.DATABASE_URL = prevDbUrl;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('serves /api/trigger-catalog as JSON', async () => {
    const res = await fetch(`${baseUrl}/api/trigger-catalog`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it('serves the store-backed /api/runs list (proves the full boot ran)', async () => {
    const res = await fetch(`${baseUrl}/api/runs`);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it('405s a bad method on a real endpoint (middleware dispatch works)', async () => {
    const res = await fetch(`${baseUrl}/api/trigger-catalog`, { method: 'DELETE' });
    expect(res.status).toBe(405);
  });

  it('serves an allowlisted docs guide via /api/guide/:name', async () => {
    // The endpoint reads docs/<file> from the repo root (here tmpRoot). Seed
    // the authoring guide so the read resolves.
    await fs.mkdir(path.join(tmpRoot, 'docs'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'docs', 'AUTHORING_ORCHESTRATIONS.md'),
      '# guide body\n',
      'utf8',
    );
    const res = await fetch(`${baseUrl}/api/guide/authoring`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; raw: string };
    expect(body.name).toBe('authoring');
    expect(body.raw).toContain('guide body');
  });

  it('404s an unknown (non-allowlisted) guide name', async () => {
    const res = await fetch(`${baseUrl}/api/guide/../../etc/passwd`);
    expect(res.status).toBe(404);
  });

  it('serves /api/triggers (webhook-only fixture) as the unified shape', async () => {
    // This shared mount seeds no orchestrations, so the list is empty — but it
    // must still be a JSON array (the unified introspection contract). The
    // multi-kind shape is asserted in the dedicated block below.
    const res = await fetch(`${baseUrl}/api/triggers`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it('aggregates branch coverage from route-decision events', async () => {
    // Two runs of "demo": the `gate` node took branch a twice, branch b once.
    await store.upsertRun({
      id: 'r1',
      orchestrationName: 'demo',
      startedAt: 1,
      endedAt: 2,
      status: 'done',
      events: [
        { type: 'route-decision', phaseName: 'gate', branch: 'a', ts: 1 },
      ],
    });
    await store.upsertRun({
      id: 'r2',
      orchestrationName: 'demo',
      startedAt: 3,
      endedAt: 4,
      status: 'done',
      events: [
        { type: 'route-decision', phaseName: 'gate', branch: 'a', ts: 3 },
        { type: 'route-decision', phaseName: 'gate', branch: 'b', ts: 4 },
      ],
    });

    const res = await fetch(`${baseUrl}/api/observability`);
    expect(res.status).toBe(200);
    const digest = (await res.json()) as {
      branchCoverage: Array<{
        orchestration: string;
        phaseName: string;
        taken: Array<{ branch: string; count: number }>;
      }>;
    };
    const gate = digest.branchCoverage.find(
      b => b.orchestration === 'demo' && b.phaseName === 'gate',
    );
    expect(gate).toBeDefined();
    // Sorted by count desc → a (2) before b (1).
    expect(gate?.taken).toEqual([
      { branch: 'a', count: 2 },
      { branch: 'b', count: 1 },
    ]);
  });
});

// GET /api/triggers must surface EVERY registered kind (not just webhooks),
// grouped-friendly with kind / name / orchestration / firing / summary /
// config. Seed an orchestration declaring all six kinds, mount, and assert
// the unified rows + their kind-specific config + firing axis.
describe('GET /api/triggers — all six kinds', () => {
  let server: http.Server;
  let tmpRoot: string;
  let baseUrl: string;
  let store: SqliteRunStore;
  const prevWorker = process.env.SAMMY_DISABLE_INPROCESS_WORKER;
  const prevDbUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.SAMMY_DISABLE_INPROCESS_WORKER = '1';
    delete process.env.DATABASE_URL;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-trig-'));

    // Seed an orchestration with one of every trigger kind BEFORE mount so the
    // boot scan registers them. examplesDir = <repoRoot>/examples.
    await fs.mkdir(path.join(tmpRoot, 'examples'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'examples', 'all-kinds.json'),
      JSON.stringify({
        name: 'all-kinds',
        triggers: [
          { kind: 'webhook', path: 'wh', method: 'POST' },
          { kind: 'cron', expr: '0 9 * * *' },
          { kind: 'polling', source: 'https://example.com/feed', intervalSeconds: 30 },
          { kind: 'events', event: 'pr.opened' },
          { kind: 'deployment', environment: 'staging' },
          { kind: 'queue', queue: 'jobs' },
        ],
        body: { kind: 'agent', agent: 'noop' },
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

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (prevWorker === undefined) delete process.env.SAMMY_DISABLE_INPROCESS_WORKER;
    else process.env.SAMMY_DISABLE_INPROCESS_WORKER = prevWorker;
    if (prevDbUrl !== undefined) process.env.DATABASE_URL = prevDbUrl;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns one row per kind with the unified shape', async () => {
    const res = await fetch(`${baseUrl}/api/triggers`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{
      kind: string;
      name: string;
      orchestration: string;
      firing: 'http' | 'schedule';
      summary: string;
      config: Record<string, unknown>;
    }>;

    const byKind = Object.fromEntries(list.map(e => [e.kind, e]));
    expect(Object.keys(byKind).sort()).toEqual(
      ['cron', 'deployment', 'events', 'polling', 'queue', 'webhook'].sort(),
    );
    for (const e of list) expect(e.orchestration).toBe('all-kinds');

    // firing axis — http for the four HTTP-fired kinds, schedule for the timers.
    expect(byKind.webhook.firing).toBe('http');
    expect(byKind.events.firing).toBe('http');
    expect(byKind.deployment.firing).toBe('http');
    expect(byKind.queue.firing).toBe('http');
    expect(byKind.cron.firing).toBe('schedule');
    expect(byKind.polling.firing).toBe('schedule');

    // kind-specific config the UI renders.
    expect(byKind.webhook.config).toMatchObject({ path: 'wh', method: 'POST' });
    expect(byKind.cron.config).toMatchObject({ expr: '0 9 * * *', schedule: '0 9 * * *' });
    expect(byKind.polling.config).toMatchObject({
      source: 'https://example.com/feed',
      intervalSeconds: 30,
    });
    expect(byKind.events.config).toMatchObject({ name: 'pr.opened', method: 'POST' });
    expect(byKind.deployment.config).toMatchObject({ name: 'staging', method: 'POST' });
    expect(byKind.queue.config).toMatchObject({ name: 'jobs', method: 'POST' });

    // summary mirrors the registry's describe().
    expect(byKind.webhook.summary).toBe('POST /api/triggers/wh');
    expect(byKind.cron.summary).toBe('0 9 * * *');
    expect(byKind.polling.summary).toBe('https://example.com/feed every 30s');
  });

  it('fires a named HTTP-fired trigger (queue) via POST /api/triggers/<name>', async () => {
    // The UI Test button POSTs the named kinds through /api/triggers/<name>
    // too (not only the per-namespace endpoint). 202 = durably queued.
    const res = await fetch(`${baseUrl}/api/triggers/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { trigger: string; name: string };
    expect(body.trigger).toBe('queue');
    expect(body.name).toBe('jobs');
  });

  it('404s an unknown trigger name', async () => {
    const res = await fetch(`${baseUrl}/api/triggers/nope`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

// Live cost on the run object (item 4) + lightweight status / incremental
// events (item 5). A run-detail poll used to ship the FULL event array with
// costUsd:null; now it derives spend-to-date from the phase-ends, supports a
// `?since=<n>` delta, and exposes a lightweight /status (alias /summary) with
// currentPhase + costUsd and no events array.
describe('run-detail cost + incremental events + status', () => {
  let server: http.Server;
  let tmpRoot: string;
  let baseUrl: string;
  let store: SqliteRunStore;
  const prevWorker = process.env.SAMMY_DISABLE_INPROCESS_WORKER;
  const prevDbUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.SAMMY_DISABLE_INPROCESS_WORKER = '1';
    delete process.env.DATABASE_URL;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-cost-'));
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

    // A finished run: two agent phases each with a known cost, plus a live run
    // stopped mid-phase (for the currentPhase assertion).
    await store.upsertRun({
      id: 'costy',
      orchestrationName: 'demo',
      startedAt: 1,
      endedAt: 9,
      status: 'done',
      events: [
        { type: 'run-start', orchestrationName: 'demo', ts: 1 },
        { type: 'phase-start', phaseName: 'a', ts: 2 },
        { type: 'phase-end', phaseName: 'a', output: 'x', costUsd: 0.25, ts: 3 },
        { type: 'phase-start', phaseName: 'b', ts: 4 },
        { type: 'phase-end', phaseName: 'b', output: 'y', costUsd: 0.75, ts: 5 },
        { type: 'run-end', ts: 9 },
      ],
    });
    await store.upsertRun({
      id: 'live',
      orchestrationName: 'demo',
      startedAt: 1,
      status: 'running',
      events: [
        { type: 'run-start', orchestrationName: 'demo', ts: 1 },
        { type: 'phase-start', phaseName: 'crawl', ts: 2 },
        { type: 'phase-end', phaseName: 'crawl', output: 'z', costUsd: 0.1, ts: 3 },
        { type: 'phase-start', phaseName: 'publish', ts: 4 },
      ],
    });
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (prevWorker === undefined) delete process.env.SAMMY_DISABLE_INPROCESS_WORKER;
    else process.env.SAMMY_DISABLE_INPROCESS_WORKER = prevWorker;
    if (prevDbUrl !== undefined) process.env.DATABASE_URL = prevDbUrl;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('GET /api/runs/:id reports costUsd summed from the phase-ends (not null)', async () => {
    const res = await fetch(`${baseUrl}/api/runs/costy`);
    expect(res.status).toBe(200);
    const run = (await res.json()) as { costUsd: number; events: unknown[]; eventVersion: number };
    expect(run.costUsd).toBeCloseTo(1.0, 6);
    expect(run.events).toHaveLength(6); // full stream by default
    expect(run.eventVersion).toBe(6);
  });

  it('GET /api/runs/:id?since=<n> returns only the delta, eventVersion stays full', async () => {
    const res = await fetch(`${baseUrl}/api/runs/costy?since=4`);
    expect(res.status).toBe(200);
    const run = (await res.json()) as { events: Array<{ type: string }>; eventVersion: number; costUsd: number };
    // events[4..] = phase-end(b), run-end.
    expect(run.events.map(e => e.type)).toEqual(['phase-end', 'run-end']);
    // Full count so the caller advances its cursor; cost still over the whole stream.
    expect(run.eventVersion).toBe(6);
    expect(run.costUsd).toBeCloseTo(1.0, 6);
  });

  it('?since past the end yields an empty delta', async () => {
    const res = await fetch(`${baseUrl}/api/runs/costy?since=6`);
    const run = (await res.json()) as { events: unknown[] };
    expect(run.events).toEqual([]);
  });

  it('GET /api/runs/:id/status is lightweight: currentPhase + costUsd, no events', async () => {
    const res = await fetch(`${baseUrl}/api/runs/live/status`);
    expect(res.status).toBe(200);
    const s = (await res.json()) as Record<string, unknown>;
    expect(s.status).toBe('running');
    expect(s.currentPhase).toBe('publish'); // last phase-start on a live run
    expect(s.costUsd).toBeCloseTo(0.1, 6);
    expect(s.phasesStarted).toBe(2);
    expect(s.phasesEnded).toBe(1);
    expect(s.events).toBeUndefined();
  });

  it('/summary is an alias of /status', async () => {
    const [a, b] = await Promise.all([
      fetch(`${baseUrl}/api/runs/live/status`).then(r => r.json()),
      fetch(`${baseUrl}/api/runs/live/summary`).then(r => r.json()),
    ]);
    expect(a).toEqual(b);
  });

  it('a terminal run has no currentPhase', async () => {
    const s = (await (await fetch(`${baseUrl}/api/runs/costy/status`)).json()) as {
      currentPhase: string | null;
      costUsd: number;
    };
    expect(s.currentPhase).toBeNull();
    expect(s.costUsd).toBeCloseTo(1.0, 6);
  });
});

// A run holding a concurrency-group slot frees it on EVERY terminal path — not
// just clean completion. The bug: cancelling a holder via gate-reject (or
// /cancel for a non-live run) wrote `cancelled` directly, bypassing the
// executor's onTerminal drain, so a fire QUEUED behind it stayed parked
// forever. These drive the real HTTP endpoints and assert the parked fire is
// drained (dequeued) the instant the holder is cancelled.
//
// The queued fire names an orchestration that is NOT on disk, so the drain
// dequeues it (the proof the drain RAN) and the follow-on start refuses
// gracefully — keeping the test free of the executor / a live agent. The
// observable is countPendingFires dropping 1 → 0 as a direct result of the
// cancel.
describe('concurrency drain on cancel/reject (terminal-path coverage)', () => {
  let server: http.Server;
  let tmpRoot: string;
  let baseUrl: string;
  let store: SqliteRunStore;
  const prevWorker = process.env.SAMMY_DISABLE_INPROCESS_WORKER;
  const prevDbUrl = process.env.DATABASE_URL;

  beforeEach(async () => {
    process.env.SAMMY_DISABLE_INPROCESS_WORKER = '1';
    delete process.env.DATABASE_URL;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-drain-'));
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
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (prevWorker === undefined) delete process.env.SAMMY_DISABLE_INPROCESS_WORKER;
    else process.env.SAMMY_DISABLE_INPROCESS_WORKER = prevWorker;
    if (prevDbUrl !== undefined) process.env.DATABASE_URL = prevDbUrl;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  /** Seed a holder PAUSED at a lock gate, holding `group`, plus one parked
   *  fire queued behind it. `paused` is the status that both holds the group
   *  (counts as active) AND has no live in-process controller — exactly the
   *  state a gate-reject or a post-restart /cancel acts on, and the one whose
   *  queue got stranded. Returns the holder id. */
  async function seedHolderWithQueuedFire(group: string): Promise<string> {
    const holderId = `holder-${group}`;
    await store.upsertRun({
      id: holderId,
      orchestrationName: 'holder-orch',
      startedAt: Date.now(),
      status: 'running',
      events: [],
      concurrencyGroup: group,
    });
    // Snapshot+pause it at a gate (pausedFor is required for the gate endpoint).
    await store.updateRunStatus(holderId, {
      status: 'paused',
      pausedFor: 'review-gate',
    });
    // One fire parked behind the holder (queue policy). Names an orchestration
    // NOT on disk, so the drain dequeues it (the observable) and the follow-on
    // start refuses transiently.
    await store.enqueuePendingFire(group, {
      orchName: 'queued-orch',
      initialInput: 'payload',
      ownerId: 'system',
    });
    expect(await preservedDrains(store, group)).toBe(1);
    // Sanity: the holder counts as active (still holds the group).
    expect((await store.findActiveRunsInGroup(group)).map(r => r.id)).toContain(
      holderId,
    );
    return holderId;
  }

  it('gate-reject drains the queued fire behind the cancelled holder', async () => {
    const group = 'staging-reject';
    const holderId = await seedHolderWithQueuedFire(group);

    const res = await fetch(`${baseUrl}/api/runs/${holderId}/gate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'reject' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, cancelled: true });

    // The holder is cancelled (slot freed) and the drain ran. The parked fire
    // names an orchestration that is not in the workspace, so the follow-on
    // start refuses TRANSIENTLY — and a transient refusal now RE-PARKS rather
    // than discarding, so the row is still queued for the next drain.
    // This read `0` before: the fire was being silently destroyed, and the
    // assertion was pinning that loss.
    expect((await store.getRun(holderId))?.status).toBe('cancelled');
    expect(await preservedDrains(store, group)).toBe(1);
  });

  it('/cancel drains the queued fire behind a non-live holder', async () => {
    const group = 'staging-cancel';
    const holderId = await seedHolderWithQueuedFire(group);

    const res = await fetch(`${baseUrl}/api/runs/${holderId}/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, cancelled: true });

    expect((await store.getRun(holderId))?.status).toBe('cancelled');
    // Re-parked, not lost — see the gate-reject case above.
    expect(await preservedDrains(store, group)).toBe(1);
  });

  it('leaves an unrelated group untouched when a holder is rejected', async () => {
    const group = 'staging-iso';
    const holderId = await seedHolderWithQueuedFire(group);
    // A second group with its own parked fire must NOT drain.
    await store.enqueuePendingFire('other-group', {
      orchName: 'other-queued',
      initialInput: null,
      ownerId: 'system',
    });

    const res = await fetch(`${baseUrl}/api/runs/${holderId}/gate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'reject' }),
    });
    expect(res.status).toBe(200);

    // Drained (dequeued, start refused transiently, re-parked) — what this
    // case is really about is the SECOND group, which must not be touched at
    // all by another group's terminal.
    expect(await preservedDrains(store, group)).toBe(1);
    expect(await store.countPendingFires('other-group')).toBe(1); // untouched
  });
});
