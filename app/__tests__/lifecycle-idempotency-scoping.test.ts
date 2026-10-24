/**
 * IDEMPOTENCY KEY SCOPING, and the polling failure modes that share its root.
 *
 * The dedupe key used to be a single GLOBAL namespace:
 *
 *   - a header key was stored as `hdr:<key>` and matched FOR ALL TIME across
 *     every endpoint and every owner. So one `Idempotency-Key` reused on two
 *     endpoints collapsed them — `POST /api/deploy/staging` then
 *     `POST /api/deploy/production` with `Idempotency-Key: release-1.2.3`
 *     silently suppressed the production fire and answered 200 carrying the
 *     STAGING delivery's ids. Across owners it let one tenant suppress
 *     another's fires and leaked delivery/run ids between them.
 *   - an auto key was `sha256(kind:name:body)`, omitting the orchestration.
 *     Two orchestrations polling the same URL each call `deliver()` once, so
 *     the second collapsed into the first and NEVER RAN.
 *
 * Both are silent: the caller gets a 200 and nothing runs. These cases pin
 * the scoping, and alongside it the polling tick's own quiet killers — an
 * un-timed fetch that retires the trigger for the life of the process, and a
 * change watermark that advanced before the delivery was durable.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import {
  destroySammyCronTasks,
  getJson,
  listRuns,
  sammyCronTasksNamed,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  postJson,
  waitFor,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(60_000);

const echoPhase = { name: 'echo', code: { source: "return 'got:' + (input || '');" } };

describe('a header Idempotency-Key is scoped to its endpoint', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await makeWorkspace('idem-scope');
    await writeOrchestration(tmpRoot, {
      name: 'deploy-staging',
      triggers: [{ kind: 'deployment', environment: 'staging' }],
      phases: [echoPhase],
    });
    await writeOrchestration(tmpRoot, {
      name: 'deploy-production',
      triggers: [{ kind: 'deployment', environment: 'production' }],
      phases: [echoPhase],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    destroySammyCronTasks();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  const deliveriesFor = async (orch: string) =>
    (await mount.store.listDeliveries(200)).filter(d => d.orchestrationName === orch);

  it('the SAME key on two different endpoints fires BOTH', async () => {
    const key = 'release-1.2.3';
    const a = await postJson<{ duplicate: boolean }>(
      `${mount.baseUrl}/api/deploy/staging`,
      { v: '1.2.3' },
      { 'idempotency-key': key },
    );
    const b = await postJson<{ duplicate: boolean }>(
      `${mount.baseUrl}/api/deploy/production`,
      { v: '1.2.3' },
      { 'idempotency-key': key },
    );

    expect([200, 202]).toContain(a.status);
    expect([200, 202]).toContain(b.status);
    // The production fire must NOT be reported as a duplicate of staging.
    expect(b.body.duplicate).toBe(false);
    expect(await deliveriesFor('deploy-staging')).toHaveLength(1);
    expect(await deliveriesFor('deploy-production')).toHaveLength(1);
  });

  it('the same key on the SAME endpoint still dedupes (the actual contract)', async () => {
    const key = 'retry-me-once';
    const first = await postJson<{ duplicate: boolean }>(
      `${mount.baseUrl}/api/deploy/staging`,
      { v: '2.0.0' },
      { 'idempotency-key': key },
    );
    const retry = await postJson<{ duplicate: boolean }>(
      `${mount.baseUrl}/api/deploy/staging`,
      { v: '2.0.0' },
      { 'idempotency-key': key },
    );

    expect(first.body.duplicate).toBe(false);
    expect(retry.body.duplicate).toBe(true);
    // One durable row for the two posts.
    const rows = (await deliveriesFor('deploy-staging')).filter(
      d => decodeURIComponent(d.idempotencyKey.split(':').pop()!) === key,
    );
    expect(rows).toHaveLength(1);
  });

  it('a key containing colons cannot impersonate another scope', async () => {
    // Plain `a:b:c` joining is ambiguous — a name of "a:b" with key "c" and a
    // name of "a" with key "b:c" collide. Components are encoded, so they
    // cannot. Both of these must be accepted as distinct fires.
    const r1 = await postJson<{ duplicate: boolean }>(
      `${mount.baseUrl}/api/deploy/staging`,
      { n: 1 },
      { 'idempotency-key': 'production:release-9' },
    );
    const r2 = await postJson<{ duplicate: boolean }>(
      `${mount.baseUrl}/api/deploy/production`,
      { n: 2 },
      { 'idempotency-key': 'release-9' },
    );
    expect(r1.body.duplicate).toBe(false);
    expect(r2.body.duplicate).toBe(false);
  });
});

describe('two orchestrations polling ONE url both fire', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;
  let server: http.Server;
  let url: string;
  let body = 'payload-1';

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    delete process.env.SAMMY_DISABLE_INPROCESS_WORKER;
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(body);
    });
    await new Promise<void>(r => server.listen(0, r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/feed`;

    tmpRoot = await makeWorkspace('poll-fanout');
    for (const name of ['poll-a', 'poll-b']) {
      await writeOrchestration(tmpRoot, {
        name,
        triggers: [{ kind: 'polling', source: url, intervalSeconds: 1 }],
        phases: [echoPhase],
      });
    }
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    destroySammyCronTasks();
    await new Promise<void>(r => server?.close(() => r()));
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  it('BOTH orchestrations run — the auto key is per-subscriber', async () => {
    // Previously the auto key was sha256(kind:name:body) with no
    // orchestration, so whichever polled first won and the other was
    // deduped into silence.
    for (const orch of ['poll-a', 'poll-b']) {
      const run = await waitFor(
        async () =>
          (await listRuns(mount.baseUrl)).find(
            r => r.orchestrationName === orch && r.status === 'done',
          ) ?? null,
        `${orch} polling fire → done run`,
        { timeoutMs: 25_000, intervalMs: 150 },
      );
      expect(run.initialInput ?? '').toContain('payload-1');
    }
  });
});

describe('a polling source that never responds must not retire the trigger', () => {
  /**
   * THE BUG THIS PINS: `schedule()` is reached only from the tick's own
   * `finally`. With no timeout on the fetch, a source that accepts the
   * connection and never answers leaves the tick pending forever — so the
   * trigger is NEVER RE-ARMED and silently stops polling for the life of the
   * process, while GET /api/triggers keeps reporting it as registered. This
   * is the same silent-stall shape as a paused Kafka partition nobody
   * resumes: nothing errors, the work just stops.
   */
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;
  let server: http.Server;
  let url: string;
  /** Held sockets, so the server can start answering later. */
  const held: http.ServerResponse[] = [];
  let hang = true;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    delete process.env.SAMMY_DISABLE_INPROCESS_WORKER;
    // Short enough that the test does not wait on the 30s default.
    process.env.SAMMY_POLL_TIMEOUT_MS = '300';

    server = http.createServer((_req, res) => {
      if (hang) {
        held.push(res); // accept, never answer
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('recovered-payload');
    });
    await new Promise<void>(r => server.listen(0, r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hang`;

    tmpRoot = await makeWorkspace('poll-hang');
    await writeOrchestration(tmpRoot, {
      name: 'poll-hang',
      triggers: [{ kind: 'polling', source: url, intervalSeconds: 1 }],
      phases: [echoPhase],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    destroySammyCronTasks();
    for (const res of held) res.destroy();
    await new Promise<void>(r => server?.close(() => r()));
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  it('keeps polling through a hanging source, and fires once it recovers', async () => {
    // Let several ticks time out against the dead source.
    await waitFor(
      async () => (held.length >= 2 ? true : null),
      'the poller retried a hanging source',
      { timeoutMs: 20_000, intervalMs: 100 },
    );

    // Now let it answer: a still-live poller must notice.
    hang = false;
    const run = await waitFor(
      async () =>
        (await listRuns(mount.baseUrl)).find(
          r => r.orchestrationName === 'poll-hang' && r.status === 'done',
        ) ?? null,
      'poller recovered → done run',
      { timeoutMs: 30_000, intervalMs: 200 },
    );
    expect(run.initialInput ?? '').toContain('recovered-payload');
  });
});

describe('a polled response is size-capped', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;
  let server: http.Server;
  let url: string;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    delete process.env.SAMMY_DISABLE_INPROCESS_WORKER;
    process.env.SAMMY_POLL_MAX_BODY_BYTES = '512';

    // A source whose body is far larger than the cap. Unbounded, this is
    // buffered into memory AND written whole into the delivery row.
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(200_000));
    });
    await new Promise<void>(r => server.listen(0, r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/big`;

    tmpRoot = await makeWorkspace('poll-big');
    await writeOrchestration(tmpRoot, {
      name: 'poll-big',
      triggers: [{ kind: 'polling', source: url, intervalSeconds: 1 }],
      phases: [echoPhase],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    destroySammyCronTasks();
    await new Promise<void>(r => server?.close(() => r()));
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  it('truncates at the cap instead of buffering the whole body', async () => {
    const delivery = await waitFor(
      async () =>
        (await mount.store.listDeliveries(50)).find(
          d => d.kind === 'polling' && d.orchestrationName === 'poll-big',
        ) ?? null,
      'oversized poll → truncated delivery',
      // Generous: the first poll is one interval out, and a slow tick under
      // parallel load backs off (baseMs * 2^failures, capped at baseMs*10),
      // so a tight budget here flakes rather than failing honestly.
      { timeoutMs: 45_000, intervalMs: 150 },
    );
    expect(delivery.body!.length).toBeGreaterThan(0);
    expect(delivery.body!.length).toBeLessThanOrEqual(512);
  });
});

describe('a throttled internal fire leaves a durable trace', () => {
  /**
   * THE BUG THIS PINS: at the queue-depth cap, `deliver()` returned
   * `{ throttled: true }` without recording anything. An HTTP caller gets a
   * 429 and can retry — but a CRON tick and an internal `publishEvent` have
   * no such channel, so the fire vanished with only a console.warn: no
   * durable row, no dead letter, no breaker signal. Under a sustained
   * backlog that silently LOST scheduled work rather than delaying it.
   *
   * It is only safe to record the refusal now that a refused row no longer
   * consumes its idempotency key — otherwise the record would poison the key
   * against the retry that is supposed to recover it.
   */
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    // Cap of 1 pending: the first fire fills the queue, the next is shed.
    process.env.SAMMY_MAX_QUEUE_DEPTH = '1';
    tmpRoot = await makeWorkspace('throttle-trace');
    await writeOrchestration(tmpRoot, {
      name: 'throttled-cron',
      // Never fires on its own; the test invokes the registered callback.
      triggers: [{ kind: 'cron', expr: '0 4 * * *' }],
      phases: [echoPhase],
    });
    await writeOrchestration(tmpRoot, {
      name: 'filler',
      triggers: [{ kind: 'webhook', path: 'filler', method: 'POST' }],
      phases: [echoPhase],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    destroySammyCronTasks();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  it('an HTTP fire past the cap gets 429 and records NOTHING', async () => {
    // It has a retry channel, and writing a row per rejected request would
    // make the cap a write amplifier.
    const first = await postJson(`${mount.baseUrl}/api/triggers/filler`, { n: 1 });
    expect([200, 202]).toContain(first.status);

    const before = (await mount.store.listDeliveries(200)).length;
    const shed = await postJson(`${mount.baseUrl}/api/triggers/filler`, { n: 2 });
    expect(shed.status).toBe(429);
    expect((await mount.store.listDeliveries(200)).length).toBe(before);
  });

  it('a CRON tick past the cap is RECORDED as rejected, and is replayable', async () => {
    const [task] = sammyCronTasksNamed('sammy:cron:throttled-cron:0 4 * * *');
    expect(task).toBeDefined();
    await task.execute!();

    const row = await waitFor(
      async () =>
        (await mount.store.listDeliveries(200)).find(
          d => d.orchestrationName === 'throttled-cron',
        ) ?? null,
      'throttled cron tick recorded',
      { timeoutMs: 10_000, intervalMs: 100 },
    );
    expect(row.status).toBe('rejected');
    expect(row.detail).toMatch(/queue full/);
    // Replayable, so the shed tick can be recovered rather than lost.
    expect(await mount.store.replayDelivery(row.id, Date.now())).toBe(true);
  });
});

describe('a re-sent fire is counted on the row that won its key', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await makeWorkspace('dupe-count');
    await writeOrchestration(tmpRoot, {
      name: 'dupe-hook',
      triggers: [{ kind: 'webhook', path: 'dupe-hook', method: 'POST' }],
      phases: [echoPhase],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    destroySammyCronTasks();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  it('three posts of one key leave ONE row with a count of 2', async () => {
    const key = 'provider-resent-this';
    for (let i = 0; i < 3; i++) {
      const { status } = await postJson(
        `${mount.baseUrl}/api/triggers/dupe-hook`,
        { n: 1 },
        { 'idempotency-key': key },
      );
      expect([200, 202]).toContain(status);
    }
    const rows = (await mount.store.listDeliveries(200)).filter(
      d => d.orchestrationName === 'dupe-hook',
    );
    expect(rows).toHaveLength(1);
    // Two of the three were suppressed — previously invisible.
    expect(rows[0].duplicateCount).toBe(2);
    expect(await mount.store.sumDuplicatesSuppressed()).toBe(2);
  });

  it('the stats endpoint reports it', async () => {
    const stats = await getJson<{ duplicatesSuppressed: number }>(
      `${mount.baseUrl}/api/deliveries/stats`,
    );
    expect(stats.duplicatesSuppressed).toBe(2);
  });
});
