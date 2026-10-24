/**
 * GET /metrics + /api/metrics on the real mount — the Prometheus text
 * endpoint renders, counts real runs from the store, and rejects non-GET.
 */

import {
  pinTestEnv,
  makeWorkspace,
  writeOrchestration,
  mountServer,
  startRun,
  waitForRun,
  type Mount,
} from './lifecycle-harness.helpers';
import { absoluteForm, rawRequest } from './raw-request.helpers';

/** The sub-paths that reached the scrape through the reused /api gates' own
 *  exemptions: the root mount strips `/metrics` by LENGTH, so `/livez` is
 *  `isProbePath` and `/triggers/x` is `isIngressPath` inside them, each
 *  reaching a bare `next()` with no credential checked. */
const SUB_PATHS = ['/livez', '/readyz', '/health', '/triggers/x', '/LIVEZ'];

let restoreEnv: () => void;
beforeAll(() => {
  restoreEnv = pinTestEnv();
});
afterAll(() => {
  restoreEnv();
});

describe('metrics endpoint', () => {
  jest.setTimeout(20_000);

  test('exposition renders with real run counts on both paths; POST is 405', async () => {
    const tmpRoot = await makeWorkspace('metrics');
    await writeOrchestration(tmpRoot, {
      name: 'tiny',
      phases: [{ name: 'a', code: { source: "return 'ok'" } }],
    });
    const m: Mount = await mountServer(tmpRoot);
    try {
      const { id } = await startRun(m.baseUrl, 'tiny');
      await waitForRun(m.baseUrl, id!, ['done']);

      for (const path of ['/metrics', '/api/metrics']) {
        const res = await fetch(`${m.baseUrl}${path}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/plain');
        const text = await res.text();
        expect(text).toContain('# TYPE sammy_runs gauge');
        expect(text).toContain('sammy_runs{status="done"} 1');
        expect(text).toContain('sammy_agent_slots_limit');
        expect(text).toContain('process_resident_memory_bytes');
      }

      const post = await fetch(`${m.baseUrl}/metrics`, { method: 'POST' });
      expect(post.status).toBe(405);

      // An exact path on both mounts. The root mount hands the handler
      // whatever follows `/metrics`, which is also what the reused /api
      // gates classify — see the gated case below.
      for (const sub of SUB_PATHS) {
        for (const base of ['/metrics', '/api/metrics']) {
          const res = await fetch(`${m.baseUrl}${base}${sub}`);
          expect(`${base}${sub} → ${res.status}`).toBe(`${base}${sub} → 404`);
        }
      }
      // A query string is not a sub-path.
      expect((await fetch(`${m.baseUrl}/metrics?x=1`)).status).toBe(200);
      // Neither is an absolute-form request target or a `#` tail. Both are
      // the resource, and the exact-path check used to 404 the resource
      // itself under each: connect leaves the protohost in `req.url` without
      // re-adding a leading slash, so a hand-rolled remainder read as
      // non-empty. A forward proxy that passes the absolute form through is
      // the realistic trigger for a Prometheus scrape.
      for (const base of ['/metrics', '/api/metrics']) {
        for (const target of [absoluteForm(m.baseUrl, base), `${base}#x`]) {
          const res = await rawRequest(m.baseUrl, target);
          expect(`${target} → ${res.status}`).toBe(`${target} → 200`);
          expect(res.body).toContain('# TYPE sammy_runs gauge');
        }
      }
    } finally {
      await m.kill();
    }
  });
});

describe('root /metrics under gated reads', () => {
  // The root mount sits outside /api and so escaped every gate — the one
  // read left open under the posture that promises none are. Prometheus can
  // send a bearer; SAMMY_METRICS_PUBLIC=1 is the explicit opt-out.
  const TOKEN = 'metrics-scrape-token';
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['SAMMY_REQUIRE_AUTH_READS', 'SAMMY_METRICS_PUBLIC'];

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.SAMMY_API_TOKEN = TOKEN;
  });
  afterEach(() => {
    delete process.env.SAMMY_API_TOKEN;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('requires the bearer on BOTH paths when reads are gated', async () => {
    process.env.SAMMY_REQUIRE_AUTH_READS = '1';
    const m: Mount = await mountServer(await makeWorkspace('metrics-gated'));
    try {
      for (const path of ['/metrics', '/api/metrics']) {
        expect((await fetch(`${m.baseUrl}${path}`)).status).toBe(401);
        expect(
          (await fetch(`${m.baseUrl}${path}`, { headers: { authorization: 'Bearer nope' } }))
            .status,
        ).toBe(401);
        const ok = await fetch(`${m.baseUrl}${path}`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(ok.status).toBe(200);
        expect(await ok.text()).toContain('# TYPE sammy_runs gauge');
      }
      // One appended segment used to serve the whole scrape
      // anonymously — the gates mounted here classify the MOUNT-RELATIVE
      // path, so `/metrics/livez` hit their own probe exemption.
      for (const sub of SUB_PATHS) {
        const res = await fetch(`${m.baseUrl}/metrics${sub}`);
        expect(`${sub} → ${res.status}`).toBe(`${sub} → 404`);
        expect(await res.text()).not.toContain('sammy_runs');
      }
      // The resource itself under the two raw spellings: 401 anonymously,
      // 200 with the scrape bearer. The gate in front of this mount already
      // classified both as the resource; the handler must agree.
      for (const target of [absoluteForm(m.baseUrl, '/metrics'), '/metrics#x']) {
        expect(`${target} anon → ${(await rawRequest(m.baseUrl, target)).status}`).toBe(
          `${target} anon → 401`,
        );
        const ok = await rawRequest(m.baseUrl, target, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(`${target} token → ${ok.status}`).toBe(`${target} token → 200`);
        expect(ok.body).toContain('# TYPE sammy_runs gauge');
      }
    } finally {
      await m.kill();
    }
  });

  test('SAMMY_METRICS_PUBLIC=1 re-opens the root path only', async () => {
    process.env.SAMMY_REQUIRE_AUTH_READS = '1';
    process.env.SAMMY_METRICS_PUBLIC = '1';
    const m: Mount = await mountServer(await makeWorkspace('metrics-public'));
    try {
      expect((await fetch(`${m.baseUrl}/metrics`)).status).toBe(200);
      expect((await fetch(`${m.baseUrl}/api/metrics`)).status).toBe(401);
    } finally {
      await m.kill();
    }
  });

  test('stays open while reads are open (a token alone changes nothing for a scrape)', async () => {
    const m: Mount = await mountServer(await makeWorkspace('metrics-open'));
    try {
      expect((await fetch(`${m.baseUrl}/metrics`)).status).toBe(200);
    } finally {
      await m.kill();
    }
  });
});
