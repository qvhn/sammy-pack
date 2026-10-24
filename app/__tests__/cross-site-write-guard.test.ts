/**
 * Cross-site writes are refused.
 *
 * Every mutating handler did `JSON.parse(await readBody(req))` with no
 * content-type check, and nothing anywhere looked at `Origin` or
 * `Sec-Fetch-Site`. So a cross-site "simple request" — no CORS preflight —
 * reached every state-changing route from any page a developer visited while
 * the server was running.
 *
 * The usual reassurance ("they can't read the response") does not apply to
 * several of these routes, because the side effect IS the damage: the
 * credential probe's side effect is an outbound request carrying a stored
 * secret, and an import's side effect is a file write. And `SAMMY_API_TOKEN`
 * is unset by default (compose leaves it empty, the Dockerfile calls it only
 * "recommended"), so the bearer gate is frequently not there either.
 *
 * `SECURITY.md`'s "the dev server binds locally and is not hardened for public
 * exposure" does not cover this: loopback binding is no defence at all against
 * a request originating from the developer's own browser.
 */

import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(30_000);

describe('cross-site write guard', () => {
  let restoreEnv: () => void;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    mount = await mountServer(await makeWorkspace('csrf-guard'));
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  const post = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${mount.baseUrl}${path}`, { method: 'POST', ...init });

  it('refuses a browser-originated cross-site write', async () => {
    const res = await post('/api/runs/start', {
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({ orchestrationName: 'whatever' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('Cross-site');
  });

  it('refuses a form-encoded body (the no-preflight simple-request shape)', async () => {
    // `application/x-www-form-urlencoded`, `text/plain` and `multipart/form-data`
    // are the three content types a cross-site form can send WITHOUT triggering
    // a CORS preflight. All three must bounce.
    for (const ct of [
      'application/x-www-form-urlencoded',
      'text/plain',
      'multipart/form-data; boundary=x',
    ]) {
      const res = await post('/api/runs/start', {
        headers: { 'content-type': ct },
        body: 'orchestrationName=whatever',
      });
      expect(res.status).toBe(415);
    }
  });

  it('refuses a body with NO content-type', async () => {
    const res = await fetch(`${mount.baseUrl}/api/runs/start`, {
      method: 'POST',
      headers: { 'content-type': '' },
      body: JSON.stringify({ orchestrationName: 'whatever' }),
    });
    expect(res.status).toBe(415);
  });

  it('allows a same-origin JSON write through to the handler', async () => {
    // Reaches the route and fails on its own terms (unknown orchestration),
    // not on the guard — i.e. the guard is not blocking legitimate traffic.
    const res = await post('/api/runs/start', {
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({ orchestrationName: 'no-such-orchestration' }),
    });
    expect(res.status).toBe(404);
  });

  it('allows a BODYLESS post with no content-type (curl, the CLI, /cancel)', async () => {
    // Routes like /cancel, /resume and /stop legitimately take no body, and
    // `fetch(url, {method:'POST'})` sends no content-type for them. Demanding
    // one would break real clients while protecting nothing — a request with
    // no body carries no payload to smuggle, and the cross-site case is
    // covered by Sec-Fetch-Site.
    const res = await post('/api/runs/does-not-exist/cancel');
    expect(res.status).toBe(404); // the route's own answer, not 415
  });

  it('leaves reads alone', async () => {
    const res = await fetch(`${mount.baseUrl}/api/runs`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(res.status).toBe(200);
  });

  it('exempts trigger ingress, which is called by senders not browsers', async () => {
    // External senders authenticate by per-trigger HMAC and may post any
    // content type their platform chooses; gating them on browser headers
    // would break real webhooks.
    const res = await post('/api/triggers/no-such-hook', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1',
    });
    expect(res.status).not.toBe(415);
    expect(res.status).not.toBe(403);
  });
});

describe('the drive-by spelling of a GET fire, through a real browser client', () => {
  // A GET-method webhook is the one mutation a foreign page can reach with an
  // `<img src>`, so the guard classifies an ingress FIRE as a mutation
  // whatever its method. `/api/triggers./<hook>` evaded that classification
  // (connect borders a mount on `.`, `INGRESS_FIRE` needs a `/`) while the
  // handler's `new URL` fired the real hook — and it needs no hand-crafted
  // client: `triggers.` is not a dot segment per WHATWG, so `fetch` and a
  // browser emit it verbatim. Driven here through plain `fetch` for exactly
  // that reason.
  let restoreEnv: () => void;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    const tmpRoot = await makeWorkspace('csrf-dot-boundary');
    await writeOrchestration(tmpRoot, {
      name: 'get-orch',
      triggers: [{ kind: 'webhook', path: 'get-hook', method: 'GET' }],
      phases: [{ name: 'p', code: { source: "return 'ok';" } }],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  const rows = async (): Promise<number> =>
    (await mount.store.listDeliveries(500)).filter(d => d.orchestrationName === 'get-orch')
      .length;

  it('fetch emits it verbatim, and it is refused with no delivery row', async () => {
    expect(new URL('/api/triggers./get-hook', 'http://h').pathname).toBe(
      '/api/triggers./get-hook',
    );
    const before = await rows();
    const res = await fetch(`${mount.baseUrl}/api/triggers./get-hook`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(res.status).toBe(400);
    expect(await rows()).toBe(before);
    // The canonical spelling is the guard's control: refused by the
    // cross-site check, and fired by a sender that is not a browser.
    const canonical = await fetch(`${mount.baseUrl}/api/triggers/get-hook`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(canonical.status).toBe(403);
    expect(await rows()).toBe(before);
    expect((await fetch(`${mount.baseUrl}/api/triggers/get-hook`)).status).toBe(202);
    expect(await rows()).toBe(before + 1);
  });
});
