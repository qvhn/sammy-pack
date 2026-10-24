/**
 * END-TO-END INTAKE CONTROLS — the ingress options and admission checks that
 * decide what an inbound fire becomes, driven through the real stack (HTTP
 * ingress → durable delivery → in-process worker → run):
 *
 *   - `idempotencyTtlSeconds`: a header key suppresses repeats only inside its
 *     window, then is accepted again.
 *   - `scrub`: the STORED delivery body and the run's input are the scrubbed
 *     payload — the raw one never lands anywhere.
 *   - intake pause: a paused orchestration's fires are HELD (no run, no
 *     dead letter, no attempt spent) and released on resume.
 *   - root `limits.maxRunsPerDay`: the fire over the cap is held, not dropped.
 *   - a templated `concurrency.group` resolves per input key.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  getJson,
  listRuns,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  postJson,
  sleep,
  waitFor,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';
import type { DeliveryRecord } from '../src/server/run-store';

jest.setTimeout(60_000);

const echoPhase = { name: 'echo', code: { source: "return 'got:' + (input || '');" } };

describe('lifecycle: intake controls', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;
  const savedSalt = process.env.SAMMY_SCRUB_SALT;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    delete process.env.SAMMY_DISABLE_INPROCESS_WORKER;
    process.env.SAMMY_SCRUB_SALT = 'test-salt';
    process.env.SAMMY_MAX_QUEUE_DEPTH = '20';
    tmpRoot = await makeWorkspace('intake');
    await writeOrchestration(tmpRoot, {
      name: 'in-window',
      triggers: [{ kind: 'queue', queue: 'in-window', idempotencyTtlSeconds: 1 }],
      phases: [echoPhase],
    });
    await writeOrchestration(tmpRoot, {
      name: 'in-scrub',
      triggers: [
        {
          kind: 'queue',
          queue: 'in-scrub',
          scrub: {
            allowFields: ['title', 'user', 'samples.*.stack', 'contact'],
            hashFields: ['user'],
          },
        },
      ],
      phases: [echoPhase],
    });
    await writeOrchestration(tmpRoot, {
      name: 'in-pause',
      triggers: [{ kind: 'queue', queue: 'in-pause' }],
      phases: [echoPhase],
    });
    await writeOrchestration(tmpRoot, {
      name: 'in-cap',
      limits: { maxRunsPerDay: 1 },
      triggers: [{ kind: 'queue', queue: 'in-cap' }],
      phases: [echoPhase],
    });
    await writeOrchestration(tmpRoot, {
      name: 'in-burst',
      limits: { maxRunsPerDay: 2 },
      triggers: [{ kind: 'queue', queue: 'in-burst' }],
      phases: [echoPhase],
    });
    await writeOrchestration(tmpRoot, {
      name: 'in-group',
      concurrency: { group: 'fp:${input.fingerprint}', policy: 'skip' },
      triggers: [{ kind: 'queue', queue: 'in-group' }],
      // A lock gate parks the run `paused`, so it keeps holding its group.
      phases: [{ name: 'hold', lock: true, code: { source: 'return input;' } }],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    if (savedSalt === undefined) delete process.env.SAMMY_SCRUB_SALT;
    else process.env.SAMMY_SCRUB_SALT = savedSalt;
    restoreEnv();
  });

  const deliveriesOf = async (orch: string): Promise<DeliveryRecord[]> =>
    (await mount.store.listDeliveries(200)).filter(d => d.orchestrationName === orch);

  const runsOf = async (orch: string) =>
    (await listRuns(mount.baseUrl)).filter(r => r.orchestrationName === orch);

  it('accepts a header key again once its idempotency window lapses', async () => {
    const send = () =>
      postJson(`${mount.baseUrl}/api/queue/in-window`, { n: 1 }, { 'Idempotency-Key': 'k1' });
    const first = await send();
    expect(first.status).toBe(202);
    const second = await send();
    expect(second.status).toBe(200);
    expect((second.body as { duplicate: boolean }).duplicate).toBe(true);
    await sleep(1_100);
    const third = await send();
    expect(third.status).toBe(202);
    const rows = await deliveriesOf('in-window');
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.keySource === 'window')).toBe(true);
    await waitFor(async () => ((await runsOf('in-window')).length === 2 ? true : null), 'two runs');
  });

  it('stores and runs only the scrubbed payload', async () => {
    const raw = {
      title: 'NPE for jane@example.com',
      user: 'uid-123',
      contact: 'call +1 415 555 0100',
      body: 'private message text',
      samples: [{ stack: 'at Foo (Bearer abcdefghijklmnop)', context: { phone: '415-555-0100' } }],
    };
    const r = await postJson(`${mount.baseUrl}/api/queue/in-scrub`, raw);
    expect(r.status).toBe(202);
    const [row] = await deliveriesOf('in-scrub');
    const stored = JSON.parse(row.body ?? '{}');
    expect(stored.body).toBeUndefined();
    expect(stored.samples[0].context).toBeUndefined();
    expect(stored.title).toBe('NPE for [email]');
    expect(stored.contact).toBe('call [phone]');
    expect(stored.samples[0].stack).toBe('at Foo (Bearer [token])');
    expect(stored.user).toMatch(/^hash:[0-9a-f]{24}$/);
    expect(row.detail).toMatch(/^scrubbed:/);
    const run = await waitFor(
      async () => (await runsOf('in-scrub')).find(x => x.status === 'done') ?? null,
      'scrub run',
    );
    const full = await getJson<{ initialInput?: string }>(`${mount.baseUrl}/api/runs/${run.id}`);
    expect(full.initialInput).toBe(row.body);
    expect(full.initialInput).not.toContain('jane@example.com');
    expect(full.initialInput).not.toContain('uid-123');
  });

  it('holds fires while intake is paused and releases them on resume', async () => {
    const p = await postJson(`${mount.baseUrl}/api/orchestrations/in-pause/pause`, {
      reason: 'investigating',
    });
    expect(p.status).toBe(200);
    expect(await postJson(`${mount.baseUrl}/api/queue/in-pause`, { a: 1 })).toMatchObject({
      status: 202,
    });
    const held = await waitFor(async () => {
      const [d] = await deliveriesOf('in-pause');
      return d && d.status === 'pending' && /paused/.test(d.detail ?? '') ? d : null;
    }, 'held delivery');
    expect(held.attempts).toBe(0);
    expect(held.availableAt).toBeGreaterThan(Date.now());
    await sleep(300);
    expect(await runsOf('in-pause')).toHaveLength(0);

    const intake = await getJson<{ paused: { reason: string } | null }>(
      `${mount.baseUrl}/api/orchestrations/in-pause/intake`,
    );
    expect(intake.paused?.reason).toBe('investigating');

    const r = await postJson<{ released: number }>(
      `${mount.baseUrl}/api/orchestrations/in-pause/resume`,
    );
    expect(r.body.released).toBe(1);
    await waitFor(
      async () => (await runsOf('in-pause')).find(x => x.status === 'done') ?? null,
      'run after resume',
    );
    const after = (await deliveriesOf('in-pause')).find(d => d.id === held.id);
    expect(after?.status).toBe('fired');
  });

  it('holds the fire over limits.maxRunsPerDay instead of dropping it', async () => {
    await postJson(`${mount.baseUrl}/api/queue/in-cap`, { i: 1 });
    await waitFor(async () => ((await runsOf('in-cap')).length === 1 ? true : null), 'first');
    await postJson(`${mount.baseUrl}/api/queue/in-cap`, { i: 2 });
    const held = await waitFor(async () => {
      const d = (await deliveriesOf('in-cap')).find(x => /maxRunsPerDay/.test(x.detail ?? ''));
      return d ?? null;
    }, 'held over cap');
    expect(held.status).toBe('pending');
    expect(held.attempts).toBe(0);
    expect(await runsOf('in-cap')).toHaveLength(1);
    const intake = await getJson<{ usage: { runsToday: number }; limitReached: string | null }>(
      `${mount.baseUrl}/api/orchestrations/in-cap/intake`,
    );
    expect(intake.usage.runsToday).toBe(1);
    expect(intake.limitReached).toMatch(/maxRunsPerDay/);
  });

  it('does not overshoot maxRunsPerDay when fires arrive together', async () => {
    // The worker claims up to 4 deliveries at once; without serializing the
    // admission check per orchestration, every concurrent fire saw "0 of 2"
    // and all of them started.
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => postJson(`${mount.baseUrl}/api/queue/in-burst`, { i })),
    );
    await waitFor(async () => {
      const ds = await deliveriesOf('in-burst');
      return ds.length === 6 && ds.every(d => d.status === 'fired' || /maxRunsPerDay/.test(d.detail ?? ''))
        ? true
        : null;
    }, 'burst settled');
    await sleep(300);
    expect(await runsOf('in-burst')).toHaveLength(2);
  });

  it('gives each input key its own concurrency group', async () => {
    // A nonce keeps two same-key fires from collapsing into one delivery
    // under the 60s auto-dedupe — this case is about the GROUP, not dedupe.
    let nonce = 0;
    const fire = (fingerprint: string) =>
      postJson(`${mount.baseUrl}/api/queue/in-group`, { fingerprint, nonce: nonce++ });
    await fire('aaa');
    await waitFor(
      async () => (await runsOf('in-group')).find(r => r.status === 'paused') ?? null,
      'first run parked at its gate',
    );
    await fire('aaa'); // same key → skipped by policy
    await fire('bbb'); // different key → runs
    await waitFor(
      async () =>
        (await runsOf('in-group')).filter(r => r.status === 'paused').length === 2 ? true : null,
      'second key runs',
    );
    const skipped = await waitFor(async () => {
      const d = (await deliveriesOf('in-group')).find(x => x.status === 'rejected');
      return d ?? null;
    }, 'same key skipped');
    expect(skipped.lastError ?? '').toMatch(/group busy/);
    const groups = (await mount.store.listRuns())
      .filter(r => r.orchestrationName === 'in-group')
      .map(r => r.concurrencyGroup)
      .sort();
    expect(groups).toEqual(['fp:aaa', 'fp:bbb']);
  });

  it('never counts held rows toward ingress backpressure', async () => {
    // 25 held rows (a pause / budget hold), not due for 10s — more than the
    // depth cap of 20. Counting them returned 429 to unrelated ingress.
    const now = Date.now();
    for (let i = 0; i < 25; i += 1) {
      await mount.store.recordDelivery({
        id: `held-${i}`,
        kind: 'queue',
        name: 'in-pause',
        orchestrationName: 'in-pause',
        idempotencyKey: `held-key-${i}`,
        keySource: 'auto',
        status: 'pending',
        body: '{}',
        receivedAt: now,
        availableAt: now + 10_000,
        detail: 'held for the test',
      });
    }
    const r = await postJson(`${mount.baseUrl}/api/queue/in-window`, { unrelated: true });
    expect(r.status).toBe(202);
  });

  it('re-parks a late drain delivery behind a busy group instead of overlapping it', async () => {
    const now = Date.now();
    await mount.store.upsertRun({
      id: 'group-holder',
      orchestrationName: 'in-window',
      startedAt: now,
      status: 'paused',
      events: [],
      concurrencyGroup: 'sammy:cron:in-window',
    });
    await mount.store.recordDelivery({
      id: 'late-drain',
      kind: 'concurrency-drain',
      name: 'sammy:cron:in-window',
      orchestrationName: 'in-window',
      idempotencyKey: 'drain:late',
      keySource: 'auto',
      status: 'pending',
      body: '{"late":true}',
      receivedAt: now,
      availableAt: now,
    });
    const d = await waitFor(async () => {
      const row = (await mount.store.listDeliveries(200)).find(x => x.id === 'late-drain');
      return row && row.status !== 'pending' && row.status !== 'claimed' ? row : null;
    }, 'late drain settled');
    expect(d.status).toBe('deferred');
    expect(await mount.store.countPendingFires('sammy:cron:in-window')).toBe(1);
    const started = (await mount.store.listRuns()).filter(
      r => r.orchestrationName === 'in-window' && r.concurrencyGroup === 'sammy:cron:in-window' && r.id !== 'group-holder',
    );
    expect(started).toHaveLength(0);
  });

  it('keeps the pause file in the workspace root', async () => {
    await postJson(`${mount.baseUrl}/api/orchestrations/in-cap/pause`);
    const raw = JSON.parse(await fs.readFile(path.join(tmpRoot, 'intake-pauses.json'), 'utf8'));
    expect(Object.keys(raw)).toContain('in-cap');
    await postJson(`${mount.baseUrl}/api/orchestrations/in-cap/resume`);
  });
});
