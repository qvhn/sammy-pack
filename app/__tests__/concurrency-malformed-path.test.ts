/**
 * A malformed percent-escape in the path must be ANSWERED, not hung.
 *
 * `/api/concurrency` parsed its segments with `.map(decodeURIComponent)` as
 * the second statement of an ASYNC handler, above both of its `try` blocks.
 * A lone `%` makes `decodeURIComponent` throw `URIError` — and because the
 * handler is async that is a REJECTED PROMISE, not a synchronous throw.
 * connect's `call()` wraps only the invocation in a sync try/catch, so it
 * never saw it, `next(err)` never ran and finalhandler never answered. The
 * request was never completed: one socket plus one `ServerResponse` pinned per
 * hit, from an unauthenticated GET under the default (reads-open) posture, and
 * `installProcessGuards()` logs `unhandledRejection` and deliberately does not
 * exit — so every status surface stayed healthy while the caller hung.
 *
 * Two properties are pinned here, and the second is the one that turns this
 * from "a weird 404" into an incident:
 *   1. every malformed shape answers (any status) inside a short budget;
 *   2. `server.close()` still completes afterwards — in-flight requests that
 *      can never finish block graceful shutdown forever, leaving SIGKILL as
 *      the only exit, which is exactly the path that strands `running` rows
 *      until the lease TTL.
 *
 * Driven with raw `http.request`, not `fetch`: `fetch` normalises a bare `%`
 * out of the path, so the attack never reaches the handler through it.
 */

import http from 'node:http';
import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(45_000);

/** Send one request down a fresh socket and report whether a response head
 *  ever arrived. Resolves `null` on timeout — a hang, not a status. */
function rawRequest(
  baseUrl: string,
  method: string,
  rawPath: string,
  budgetMs = 1_500,
): Promise<number | null> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise(resolve => {
    let settled = false;
    const done = (v: number | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const req = http.request(
      { host: hostname, port, method, path: rawPath, agent: false },
      res => {
        res.resume();
        res.on('end', () => done(res.statusCode ?? 0));
      },
    );
    req.on('error', () => done(null));
    setTimeout(() => {
      req.destroy();
      done(null);
    }, budgetMs);
    req.end();
  });
}

describe('/api/concurrency answers a malformed percent-escape', () => {
  let restoreEnv: () => void;
  let mount: Mount;

  const MALFORMED = [
    '/api/concurrency/%',
    '/api/concurrency/%E0%A4%A',
    '/api/concurrency/a/%ZZ',
  ];

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    mount = await mountServer(await makeWorkspace('concurrency-malformed'));
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  it('answers the control request', async () => {
    expect(await rawRequest(mount.baseUrl, 'GET', '/api/concurrency')).toBe(200);
  });

  it('answers every malformed GET instead of pinning the socket', async () => {
    for (const p of MALFORMED) {
      const status = await rawRequest(mount.baseUrl, 'GET', p);
      expect(`${p} → ${status}`).toBe(`${p} → 200`);
    }
  });

  it('answers the malformed DELETE-queued shape too', async () => {
    // The same parse feeds the withdraw path, where `segs[2]` is the fire id.
    const status = await rawRequest(
      mount.baseUrl,
      'DELETE',
      '/api/concurrency/%/queued',
    );
    expect(status).not.toBeNull();
    expect(status).toBe(200);
  });

  it('still DECODES a legitimately-escaped group name (no drift)', async () => {
    // Tolerating a bad escape must not stop honouring a good one: a group
    // whose name contains a space is only addressable through the decode.
    await mount.store.enqueuePendingFire('stage env', {
      orchName: 'some-orch',
      initialInput: null,
      ownerId: 'system',
    });
    const res = await fetch(
      `${mount.baseUrl}/api/concurrency/stage%20env/queued`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ withdrawn: 1 });
    expect(await mount.store.listPendingFires('stage env')).toEqual([]);
  });

  it('leaves the server able to shut down gracefully', async () => {
    for (const p of MALFORMED) await rawRequest(mount.baseUrl, 'GET', p);
    // A never-answered request blocks close() for the life of the process.
    const closed = await Promise.race([
      new Promise<boolean>(resolve =>
        mount.server.close(() => resolve(true)),
      ),
      new Promise<boolean>(resolve => {
        setTimeout(() => resolve(false), 2_000);
      }),
    ]);
    expect(closed).toBe(true);
  });
});
