/**
 * The health surface must be able to FAIL.
 *
 * `/api/health` answered HTTP 200 unconditionally — including the branch whose
 * body says `status:'degraded', store:'unreachable'`. The image's HEALTHCHECK
 * tests `r.ok`, so a server that KNEW its store was gone reported healthy to
 * Docker, to a load balancer, and to any orchestrator probe, forever. The
 * failure class this project is built to refuse — work stops while every
 * status surface reports healthy — had the status surface itself as an
 * instance, so the status code is pinned here rather than left to inspection.
 *
 * Also pins the liveness/readiness split: an unreachable store must NOT fail
 * liveness, because killing and restarting the process cannot fix a database
 * that is down and discards every in-flight run on the way.
 *
 * The store is broken the way production breaks it — the handle is closed out
 * from under the server, so `probeStore` throws for real. No mocks.
 */

import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(30_000);

type Probe = { status: number; body: Record<string, unknown> };

async function probe(url: string): Promise<Probe> {
  const res = await fetch(url);
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}

describe('health / liveness / readiness status codes', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await makeWorkspace('health-codes');
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  describe('with a healthy store', () => {
    it('/api/health is 200 and reports ok', async () => {
      const { status, body } = await probe(`${mount.baseUrl}/api/health`);
      expect(status).toBe(200);
      expect(body.status).toBe('ok');
      expect((body.capabilities as { store: string }).store).toBe('ok');
    });

    it('/api/readyz is 200 and /api/livez is 200', async () => {
      expect(await probe(`${mount.baseUrl}/api/readyz`)).toMatchObject({
        status: 200,
        body: { status: 'ready', store: 'ok' },
      });
      expect(await probe(`${mount.baseUrl}/api/livez`)).toMatchObject({
        status: 200,
        body: { status: 'alive' },
      });
    });

    it('rejects a mutating method on the probes', async () => {
      for (const p of ['livez', 'readyz']) {
        const res = await fetch(`${mount.baseUrl}/api/${p}`, { method: 'POST' });
        expect(res.status).toBe(405);
      }
    });
  });

  describe('with the store closed out from under it', () => {
    beforeAll(async () => {
      // Exactly what a lost database looks like to the handlers: the next
      // query throws. Closing the handle is how the lifecycle harness
      // simulates process-level failure elsewhere in this suite.
      await mount.store.close();
    });

    it('/api/health reports degraded AND answers 503', async () => {
      const { status, body } = await probe(`${mount.baseUrl}/api/health`);
      // The body was always right. The STATUS CODE was the bug — it is what
      // Docker, a load balancer and a readinessProbe actually read.
      expect(body.status).toBe('degraded');
      expect(status).toBe(503);
    });

    it('/api/readyz answers 503 — it must leave the load-balancer pool', async () => {
      const { status, body } = await probe(`${mount.baseUrl}/api/readyz`);
      expect(status).toBe(503);
      expect(body.status).toBe('not-ready');
      expect(body.store).toBe('unreachable');
    });

    it('/api/livez stays 200 — a dead store is not a dead process', async () => {
      // If liveness failed here, Kubernetes would kill and restart the pod in
      // a loop: it cannot fix an unreachable database, and each restart
      // abandons every in-flight run.
      const { status, body } = await probe(`${mount.baseUrl}/api/livez`);
      expect(status).toBe(200);
      expect(body.status).toBe('alive');
    });
  });
});
