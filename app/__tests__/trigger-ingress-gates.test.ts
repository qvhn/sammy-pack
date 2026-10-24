/**
 * Trigger ingress is gated like the rest of the API, minus the parts an
 * external sender genuinely cannot satisfy.
 *
 * Every /api middleware exempted `/triggers|/events|/deploy|/queue` wholesale
 * on the reasoning "called by senders, authenticates by HMAC". Two
 * consequences: a `read`-role identity refused at /api/runs/start fired a
 * trigger and got a delivery row (403 one door, 202 the next), and a
 * browser-originated cross-site POST (`Sec-Fetch-Site: cross-site`) reached
 * ingress because the cross-site guard skipped it. The named-trigger
 * dispatcher (/api/events, /deploy, /queue) also had no method check, so a
 * GET fired it. And "authenticates by HMAC" was only true of triggers marked
 * `signed` — SAMMY_REQUIRE_SIGNED_TRIGGERS=1 now makes it true of all.
 *
 * Then the same bypass came back twice over a PATH SPELLING, because the
 * gates classify the path as a string while the handlers re-parse it with
 * `new URL`: case, then an empty segment, then connect's `.` mount boundary,
 * each one a real fire the classifiers could not see. Case (e) and the fire
 * routes' canonical/absolute forms still pin the classifiers; (f) pins the
 * rule that closed the class — a non-canonical path is refused above every
 * gate, so there is only one spelling for the two parsers to agree on.
 */

import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  postJson,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';
import { absoluteForm, rawRequest } from './raw-request.helpers';
import { signWebhookBody } from '../src/server/webhook-auth';
import { signJwtHS256 } from '../src/server/jwt-verify';

jest.setTimeout(45_000);

const SECRET = 'ingress-gate-secret';

async function workspace(prefix: string): Promise<string> {
  const tmpRoot = await makeWorkspace(prefix);
  await writeOrchestration(tmpRoot, {
    name: 'hook-orch',
    triggers: [{ kind: 'webhook', path: 'hook1', method: 'POST' }],
    phases: [{ name: 'p', code: { source: "return 'ok';" } }],
  });
  await writeOrchestration(tmpRoot, {
    name: 'evt-orch',
    triggers: [
      { kind: 'events', event: 'evt1' },
      { kind: 'deployment', environment: 'staging' },
    ],
    phases: [{ name: 'p', code: { source: "return 'ok';" } }],
  });
  await writeOrchestration(tmpRoot, {
    name: 'signed-orch',
    triggers: [{ kind: 'webhook', path: 'sig-hook', method: 'POST', signed: true }],
    phases: [{ name: 'p', code: { source: "return 'ok';" } }],
  });
  // The trigger shape allows a GET-method webhook; a fire is a fire.
  await writeOrchestration(tmpRoot, {
    name: 'get-orch',
    triggers: [{ kind: 'webhook', path: 'get-hook', method: 'GET' }],
    phases: [{ name: 'p', code: { source: "return 'ok';" } }],
  });
  await writeOrchestration(tmpRoot, {
    name: 'q-orch',
    triggers: [{ kind: 'queue', queue: 'q1' }],
    phases: [{ name: 'p', code: { source: "return 'ok';" } }],
  });
  return tmpRoot;
}

/** Every spelling of a fire on `/api/<kind>/<name>` that is NOT already
 *  canonical. Each one reached a handler as a REAL fire (`new URL` resolves
 *  what the gates' string classifiers do not, and connect borders a mount on
 *  `.` as well as `/`) while no gate classified it as a fire — so each is
 *  refused above every gate now, 400, and must never reach a handler. */
const nonCanonical = (kind: string, name: string): string[] => [
  `/api/${kind}//x/${name}`,
  `/api/${kind}/../${name}`,
  `/api/${kind}/./${name}`,
  `/api/${kind}/%2e%2e/${name}`,
  `/api/${kind}/%2f${name}`,
  `/api/${kind}.`,
  `/api/${kind}./${name}`,
  `/api/${kind}./../${name}`,
  `/api/${kind}.x/../${name}`,
  `/api/${kind}.json/../${name}`,
  `/api/${kind}.;/../${name}`,
  `/api/${kind}.\\../${name}`,
  `/api/${kind}./..\\${name}`,
  `/api/${kind}./%2e%2e/${name}`,
  `/api/${kind}..//${name}`,
  `/api/${kind.toUpperCase()}./../${name}`,
  `/api/${kind}.${'a'.repeat(200)}/../${name}`,
];

/** Every ingress FIRE route, with the spellings that used to reach it without
 *  any gate classifying it as a fire. */
const FIRES = [
  {
    kind: 'triggers GET',
    orch: 'get-orch',
    method: 'GET',
    canonical: '/api/triggers/get-hook',
    spellings: nonCanonical('triggers', 'get-hook'),
  },
  {
    kind: 'triggers POST',
    orch: 'hook-orch',
    method: 'POST',
    canonical: '/api/triggers/hook1',
    spellings: nonCanonical('triggers', 'hook1'),
  },
  {
    kind: 'events',
    orch: 'evt-orch',
    method: 'POST',
    canonical: '/api/events/evt1',
    spellings: nonCanonical('events', 'evt1'),
  },
  {
    kind: 'deploy',
    orch: 'evt-orch',
    method: 'POST',
    canonical: '/api/deploy/staging',
    spellings: nonCanonical('deploy', 'staging'),
  },
  {
    kind: 'queue',
    orch: 'q-orch',
    method: 'POST',
    canonical: '/api/queue/q1',
    spellings: nonCanonical('queue', 'q1'),
  },
] as const;

/** The `error` field of a refusal read as raw text (rawRequest does not parse
 *  JSON, and the message quotes the role name). */
const errorOf = (body: string): string =>
  (JSON.parse(body) as { error?: string }).error ?? '';

/** Delivery rows for one orchestration — the durable proof a fire was or was
 *  not accepted (the in-process worker is off, so rows stay put). */
const rowsFor = async (mount: Mount, orch: string): Promise<number> =>
  (await mount.store.listDeliveries(500)).filter(d => d.orchestrationName === orch)
    .length;

describe('trigger ingress gates', () => {
  let restoreEnv: () => void;
  let mount: Mount;
  const prevReadonly = process.env.SAMMY_READONLY_USERS;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_READONLY_USERS = 'bob';
    mount = await mountServer(await workspace('ingress-gates'));
  });

  afterAll(async () => {
    await mount?.kill();
    if (prevReadonly === undefined) delete process.env.SAMMY_READONLY_USERS;
    else process.env.SAMMY_READONLY_USERS = prevReadonly;
    restoreEnv?.();
  });

  describe('(c) the role gate covers fires', () => {
    // This posture is OPEN (no token, no verifier): identity is the
    // client-supplied header everywhere, ingress included, so a sender that
    // NAMES a read-role owner is refused and one that names a write-role
    // owner fires as that owner. Under a gated posture an unauthenticated
    // fire carries no identity at all — see auth-posture-compose.
    //
    // On the bearer gate's probe-path header strip (/livez, /readyz,
    // /health): nothing downstream of a probe reads `X-Sammy-User`, so the
    // strip has no observable effect today. It is defence in depth against a
    // future probe that does — not the closure of a bypass — and is
    // deliberately left without a test that would only pin an implementation
    // detail.
    it('a self-identified read-role caller is refused at /api/runs/start AND at a trigger', async () => {
      const start = await postJson(
        `${mount.baseUrl}/api/runs/start`,
        { orchestrationName: 'hook-orch' },
        { 'x-sammy-user': 'bob' },
      );
      expect(start.status).toBe(403);
      const before = await rowsFor(mount, 'hook-orch');
      const fire = await postJson<{ error: string }>(
        `${mount.baseUrl}/api/triggers/hook1`,
        { n: 1 },
        { 'x-sammy-user': 'bob' },
      );
      expect(fire.status).toBe(403);
      expect(fire.body.error).toContain('"read" role');
      expect(await rowsFor(mount, 'hook-orch')).toBe(before);
    });

    it('covers the named dispatchers too', async () => {
      const res = await postJson(
        `${mount.baseUrl}/api/events/evt1`,
        { n: 1 },
        { 'x-sammy-user': 'bob' },
      );
      expect(res.status).toBe(403);
      expect(await rowsFor(mount, 'evt-orch')).toBe(0);
    });

    it('an anonymous sender has no identity, fires as system, and is unaffected', async () => {
      const res = await postJson<{ deliveryId: string }>(
        `${mount.baseUrl}/api/triggers/hook1`,
        { n: 2 },
      );
      expect(res.status).toBe(202);
      const row = (await mount.store.listDeliveries(500)).find(d => d.id === res.body.deliveryId);
      expect(row?.ownerId).toBe('system');
    });

    it('a write-role identity fires as before', async () => {
      const res = await postJson(
        `${mount.baseUrl}/api/triggers/hook1`,
        { n: 3 },
        { 'x-sammy-user': 'alice' },
      );
      expect(res.status).toBe(202);
    });

    it('a read-role identity can still LIST triggers (that is a read)', async () => {
      for (const path of ['/api/triggers', '/api/events', '/api/deploy']) {
        const res = await fetch(`${mount.baseUrl}${path}`, {
          headers: { 'x-sammy-user': 'bob' },
        });
        expect(res.status).toBe(200);
      }
    });
  });

  describe('(b) the cross-site guard covers ingress', () => {
    it('a browser cross-site POST is refused, even with a sender content-type', async () => {
      const before = await rowsFor(mount, 'hook-orch');
      const res = await fetch(`${mount.baseUrl}/api/triggers/hook1`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' },
        body: 'hello',
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toContain('Cross-site');
      expect(await rowsFor(mount, 'hook-orch')).toBe(before);
    });

    it('keeps the content-type exemption — senders post any type', async () => {
      const res = await fetch(`${mount.baseUrl}/api/triggers/hook1`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'hello',
      });
      expect(res.status).toBe(202);
    });

    it('a GET-method webhook fired cross-site (an <img src>, a prefetch) is refused', async () => {
      // The guard used to return early for every read method before looking
      // at Sec-Fetch-Site, so a GET fire — which starts a run exactly like a
      // POST fire — was the one mutation a foreign page could still reach.
      const before = await rowsFor(mount, 'get-orch');
      const res = await fetch(`${mount.baseUrl}/api/triggers/get-hook`, {
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toContain('Cross-site');
      expect(await rowsFor(mount, 'get-orch')).toBe(before);
      // A sender (no browser headers) still fires it.
      const sender = await fetch(`${mount.baseUrl}/api/triggers/get-hook`);
      expect(sender.status).toBe(202);
      expect(await rowsFor(mount, 'get-orch')).toBe(before + 1);
    });

    it('same-origin browser fires (the UI Test button) still work', async () => {
      const res = await fetch(`${mount.baseUrl}/api/events/evt1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: '{}',
      });
      expect(res.status).toBe(202);
    });
  });

  describe('(e) the gates classify on a case-folded path', () => {
    // connect matches a mount prefix case-insensitively and strips it by
    // LENGTH, so `GET /API/TRIGGERS/get-hook` reaches the trigger handler
    // with req.url `/TRIGGERS/get-hook` — and every classifier in the /api
    // chain was case-sensitive. The cross-site guard saw a plain read, the
    // role gate saw a non-ingress GET: four upper-cased characters fired
    // the hook from a foreign page and as a read-role identity.
    const SPELLINGS = ['/API/TRIGGERS/get-hook', '/api/TRIGGERS/get-hook', '/Api/Triggers/get-hook'];

    it('a cross-site GET fire is refused whatever the path case', async () => {
      const before = await rowsFor(mount, 'get-orch');
      for (const p of SPELLINGS) {
        const res = await fetch(`${mount.baseUrl}${p}`, {
          headers: { 'sec-fetch-site': 'cross-site' },
        });
        expect(`${p} → ${res.status}`).toBe(`${p} → 403`);
        expect((await res.json()).error).toContain('Cross-site');
      }
      expect(await rowsFor(mount, 'get-orch')).toBe(before);
    });

    it('a read-role identity cannot fire through an upper-cased path', async () => {
      const before = await rowsFor(mount, 'get-orch');
      for (const p of SPELLINGS) {
        const res = await fetch(`${mount.baseUrl}${p}`, {
          headers: { 'x-sammy-user': 'bob' },
        });
        expect(`${p} → ${res.status}`).toBe(`${p} → 403`);
        expect((await res.json()).error).toContain('"read" role');
      }
      expect(await rowsFor(mount, 'get-orch')).toBe(before);
    });

    it('a non-ingress mutation is gated identically under any spelling', async () => {
      for (const p of ['/Api/Runs/Start', '/API/RUNS/START']) {
        const crossSite = await fetch(`${mount.baseUrl}${p}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
          body: JSON.stringify({ orchestrationName: 'hook-orch' }),
        });
        expect(`${p} cross-site → ${crossSite.status}`).toBe(`${p} cross-site → 403`);
        const readRole = await postJson(
          `${mount.baseUrl}${p}`,
          { orchestrationName: 'hook-orch' },
          { 'x-sammy-user': 'bob' },
        );
        expect(`${p} read-role → ${readRole.status}`).toBe(`${p} read-role → 403`);
      }
    });

    it('the ingress content-type exemption follows the folded path too', async () => {
      // Fail-closed before the fix (415), so availability rather than
      // security — but the exemption and the guard must agree on what
      // ingress is, or a sender's provider-chosen path case decides it.
      const res = await fetch(`${mount.baseUrl}/API/TRIGGERS/hook1`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'hello-from-an-upper-cased-path',
      });
      expect(res.status).toBe(202);
    });
  });

  describe('(f) only a canonical path reaches a gate or a handler', () => {
    // Case-folding was only the first spelling. The gates read the
    // mount-stripped `req.url` as a string while the ingress handlers
    // re-parse it with `new URL`, and where the two disagreed the HANDLER
    // won — three rounds of classifier patches each closed one spelling and
    // left the next:
    //
    //   `/api/triggers//x/<hook>` — the empty segment defeats INGRESS_FIRE's
    //   `[^/?]+`, while the handler's `new URL('//x/<hook>')` is
    //   protocol-relative and fires <hook>. A browser does not collapse
    //   duplicate slashes, so this shape is `<img src>`-reachable.
    //
    //   `/api/triggers./../<hook>` — connect borders a mount on `.` as well
    //   as `/`, so this is ROUTED to `/api/triggers` and `new URL` resolves
    //   the remainder back to the real hook, while `INGRESS_FIRE` (which
    //   needs a `/` after the kind word) cannot match it: the cross-site
    //   guard took its read-method early return and the role gate its
    //   non-ingress branch. `triggers.` is not a dot segment per WHATWG, so
    //   a browser emits it verbatim — no raw client needed.
    //
    //   `GET http://host/api/triggers/<hook>` (absolute-form request target)
    //   — connect strips a mount by LENGTH from after the protohost, so
    //   neither the `^/`-anchored regex nor `startsWith` matched, and the
    //   bearer gate's identity strip never ran. `fetch` cannot emit this
    //   target; see raw-request.helpers.
    //
    // So the class is closed instead of the spellings: a non-canonical path
    // is refused 400 above every gate, and the absolute form — the one
    // spelling a proxy legitimately sends — is canonicalised by `gatePath`
    // and classified like the origin form.
    let seq = 0;
    for (const f of FIRES) {
      it(`${f.kind}: every non-canonical spelling is 400 for an anonymous, a cross-site and a read-role caller`, async () => {
        const before = await rowsFor(mount, f.orch);
        for (const target of f.spellings) {
          for (const [vector, headers] of [
            // Anonymous is the vector that mattered: with no identity to
            // refuse, these spellings were a 202 and a delivery row.
            ['anonymous', {}],
            ['cross-site', { 'sec-fetch-site': 'cross-site' }],
            ['read-role', { 'x-sammy-user': 'bob' }],
          ] as const) {
            seq += 1;
            const res = await rawRequest(mount.baseUrl, target, {
              method: f.method,
              headers: {
                'content-type': 'application/json',
                'idempotency-key': `canon-${seq}`,
                ...headers,
              },
              body: f.method === 'POST' ? JSON.stringify({ n: seq }) : undefined,
            });
            const label = `${f.kind} ${target} ${vector}`;
            expect(`${label} → ${res.status}`).toBe(`${label} → 400`);
            expect(errorOf(res.body)).toContain('Bad request');
          }
        }
        // The durable proof: not one of them started a run.
        expect(await rowsFor(mount, f.orch)).toBe(before);
      });

      it(`${f.kind}: the absolute form of the canonical path is classified as a fire`, async () => {
        const before = await rowsFor(mount, f.orch);
        for (const [vector, headers] of [
          ['cross-site', { 'sec-fetch-site': 'cross-site' }],
          ['read-role', { 'x-sammy-user': 'bob' }],
        ] as const) {
          seq += 1;
          const res = await rawRequest(
            mount.baseUrl,
            absoluteForm(mount.baseUrl, f.canonical),
            {
              method: f.method,
              headers: {
                'content-type': 'application/json',
                'idempotency-key': `abs-${seq}`,
                ...headers,
              },
              body: f.method === 'POST' ? JSON.stringify({ n: seq }) : undefined,
            },
          );
          const label = `${f.kind} absolute-form ${vector}`;
          expect(`${label} → ${res.status}`).toBe(`${label} → 403`);
        }
        expect(await rowsFor(mount, f.orch)).toBe(before);
      });
    }

    it('the refusal names what is wrong with the path', async () => {
      // A 400 an operator cannot read is a support ticket. Each rule says
      // which one it was.
      for (const [target, reason] of [
        ['/api/triggers//x/hook1', 'an empty path segment'],
        ['/api/triggers/../hook1', 'a ".." segment'],
        ['/api/triggers/./hook1', 'a "." segment'],
        ['/api/triggers/%2e%2e/hook1', 'a ".." segment'],
        ['/api/triggers/%2fhook1', 'an encoded "/"'],
        ['/api/triggers/\\hook1', 'a backslash'],
        ['/api/triggers./hook1', 'a path segment ending in "."'],
        ['/api/triggers.x/hook1', 'connect\'s "." boundary'],
      ] as const) {
        const res = await rawRequest(mount.baseUrl, target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        expect(`${target} → ${res.status}`).toBe(`${target} → 400`);
        expect(errorOf(res.body)).toContain(reason);
      }
    });

    it('a canonical deep path on a non-ingress route still works', async () => {
      // The guard refuses spellings, not depth: every real route the UI and
      // the CLI call is canonical, including the nested ones.
      for (const path of [
        '/api/orchestrations/hook-orch',
        '/api/openapi.json',
        '/api/triggers/',
        '/api/livez',
        '/api/health',
      ]) {
        const res = await fetch(`${mount.baseUrl}${path}`);
        expect(`${path} → ${res.status}`).toBe(`${path} → 200`);
      }
      // A hook name is one segment and may carry its own percent-encoding.
      const unknown = await postJson(`${mount.baseUrl}/api/triggers/my%20hook`, {});
      expect(unknown.status).toBe(404);
    });

    it('an absolute-form target is recognised the way connect recognises one', async () => {
      // connect's `getProtohost` keeps anything before the first `/` after a
      // `://` — it does not check the scheme's shape — so a classifier that
      // only knew `http://` would part company with the routing over an odd
      // one. All three reach the handler; none may reach it as a read.
      const before = await rowsFor(mount, 'get-orch');
      const { port } = new URL(mount.baseUrl);
      for (const scheme of ['HTTP', 'ws', 'foo']) {
        const target = `${scheme}://127.0.0.1:${port}/api/triggers/get-hook`;
        const res = await rawRequest(mount.baseUrl, target, {
          headers: { 'x-sammy-user': 'bob' },
        });
        expect(`${scheme} → ${res.status}`).toBe(`${scheme} → 403`);
      }
      expect(await rowsFor(mount, 'get-orch')).toBe(before);
    });

    it('a non-ingress mutation is refused under both spellings too (control)', async () => {
      // The guard is not ingress-specific — it is the whole /api chain's
      // front door — so a non-canonical non-ingress mutation is 400 and the
      // absolute form of the same route is still the gates' 403.
      for (const [spelling, target, status] of [
        ['double-slash', '/api//runs/start', 400],
        ['dot-parent', '/api/runs/../runs/start', 400],
        ['absolute-form', absoluteForm(mount.baseUrl, '/api/runs/start'), 403],
      ] as const) {
        for (const [vector, headers] of [
          ['cross-site', { 'sec-fetch-site': 'cross-site' }],
          ['read-role', { 'x-sammy-user': 'bob' }],
        ] as const) {
          const res = await rawRequest(mount.baseUrl, target, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ orchestrationName: 'hook-orch' }),
          });
          const label = `${spelling} ${vector}`;
          expect(`${label} → ${res.status}`).toBe(`${label} → ${status}`);
        }
      }
      // And a canonical path the guard leaves alone is still judged by the
      // gates, not by its spelling: an unknown resource under a read role is
      // the role gate's 403, and a query string is not part of the path.
      for (const target of [
        '/api/%74riggers/hook1',
        '/api/triggers/hook1?x=/livez',
      ]) {
        const res = await rawRequest(mount.baseUrl, target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-sammy-user': 'bob',
          },
          body: '{}',
        });
        expect(`${target} → ${res.status}`).toBe(`${target} → 403`);
        expect(errorOf(res.body)).toContain('"read" role');
      }
    });

    it('a sender still fires every canonical path (the control the refusals are measured against)', async () => {
      for (const f of FIRES) {
        const before = await rowsFor(mount, f.orch);
        seq += 1;
        const res = await rawRequest(mount.baseUrl, f.canonical, {
          method: f.method,
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `canon-ok-${seq}`,
          },
          body: f.method === 'POST' ? JSON.stringify({ n: seq }) : undefined,
        });
        expect(`${f.kind} → ${res.status}`).toBe(`${f.kind} → 202`);
        expect(await rowsFor(mount, f.orch)).toBe(before + 1);
      }
    });

    it('the probe exemption is not reachable through another resource (no path can be shortened into it)', async () => {
      // `isProbePath` is an EXEMPTION, so nothing may make a path SHORTER
      // than the mount it is routed to: `new URL` resolves a `..` segment and
      // connect's mount matching does not, so a canonicaliser that resolved
      // one would exempt `/api/<resource>/../livez` from the read gate while
      // the resource's own handler answers it. That is why the guard rejects
      // instead of resolving — the shortened spelling never gets a verdict
      // from either parser.
      for (const target of [
        '/api/runs/../livez',
        '/api/runs/%2e%2e/livez',
        '/api/runs/..%2flivez',
        '/api/orchestrations/../health',
      ]) {
        const res = await rawRequest(mount.baseUrl, target, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json', 'x-sammy-user': 'bob' },
        });
        expect(`${target} → ${res.status}`).toBe(`${target} → 400`);
      }
      // The probes themselves still answer, and the role gate still refuses
      // a read-role mutation on a canonical resource (the control the
      // refusals above are measured against).
      expect((await fetch(`${mount.baseUrl}/api/livez`)).status).toBe(200);
      const mutation = await rawRequest(mount.baseUrl, '/api/runs/livez', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', 'x-sammy-user': 'bob' },
      });
      expect(mutation.status).toBe(403);
      expect(errorOf(mutation.body)).toContain('"read" role');
    });
  });

  describe('(a) the named dispatchers enforce POST', () => {
    it('GET / PUT / DELETE on a registered name is 405, not a fire', async () => {
      const before = await rowsFor(mount, 'evt-orch');
      for (const [path, method] of [
        ['/api/events/evt1', 'GET'],
        ['/api/events/evt1', 'PUT'],
        ['/api/deploy/staging', 'GET'],
        ['/api/deploy/staging', 'DELETE'],
      ] as const) {
        const res = await fetch(`${mount.baseUrl}${path}`, { method });
        expect(`${method} ${path} → ${res.status}`).toBe(`${method} ${path} → 405`);
      }
      expect(await rowsFor(mount, 'evt-orch')).toBe(before);
    });

    it('the bare list is still a GET', async () => {
      const res = await fetch(`${mount.baseUrl}/api/events`);
      expect(res.status).toBe(200);
      expect((await res.json()).map((e: { name: string }) => e.name)).toContain('evt1');
    });
  });
});

describe('(d) SAMMY_REQUIRE_SIGNED_TRIGGERS=1', () => {
  let restoreEnv: () => void;
  let mount: Mount;
  const prevRequire = process.env.SAMMY_REQUIRE_SIGNED_TRIGGERS;
  // Captured during the mount, before the spies are restored (restoring
  // clears the recorded calls).
  let banner = '';
  let warns = '';

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_WEBHOOK_SECRET = SECRET;
    process.env.SAMMY_REQUIRE_SIGNED_TRIGGERS = '1';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mount = await mountServer(await workspace('require-signed'));
      banner =
        logSpy.mock.calls.map(c => String(c[0])).find(l => l.includes('boot config:')) ?? '';
      warns = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  afterAll(async () => {
    await mount?.kill();
    if (prevRequire === undefined) delete process.env.SAMMY_REQUIRE_SIGNED_TRIGGERS;
    else process.env.SAMMY_REQUIRE_SIGNED_TRIGGERS = prevRequire;
    restoreEnv?.();
  });

  it('refuses an unsigned webhook at fire time, with no delivery row', async () => {
    const res = await postJson<{ error: string }>(`${mount.baseUrl}/api/triggers/hook1`, {
      n: 1,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('SAMMY_REQUIRE_SIGNED_TRIGGERS');
    expect(await rowsFor(mount, 'hook-orch')).toBe(0);
  });

  it('refuses an unsigned named trigger on both of its routes', async () => {
    expect((await postJson(`${mount.baseUrl}/api/events/evt1`, {})).status).toBe(403);
    expect((await postJson(`${mount.baseUrl}/api/triggers/evt1`, {})).status).toBe(403);
    expect(await rowsFor(mount, 'evt-orch')).toBe(0);
  });

  it('refuses them under the odd path spellings too — the last backstop holds', async () => {
    // This flag was the only control that already refused every spelling (it
    // is enforced in the handler, which parses the path the same way either
    // way). Pinned so neither the guard nor a classifier can quietly re-route
    // a fire around it: a non-canonical spelling never reaches the handler at
    // all (400), and the absolute form reaches it and is refused by the flag.
    for (const f of FIRES) {
      const before = await rowsFor(mount, f.orch);
      for (const target of f.spellings) {
        const res = await rawRequest(mount.baseUrl, target, {
          method: f.method,
          headers: { 'content-type': 'application/json' },
          body: f.method === 'POST' ? JSON.stringify({ n: 1 }) : undefined,
        });
        expect(`${f.kind} ${target} → ${res.status}`).toBe(`${f.kind} ${target} → 400`);
      }
      const abs = await rawRequest(mount.baseUrl, absoluteForm(mount.baseUrl, f.canonical), {
        method: f.method,
        headers: { 'content-type': 'application/json' },
        body: f.method === 'POST' ? JSON.stringify({ n: 1 }) : undefined,
      });
      expect(`${f.kind} absolute → ${abs.status}`).toBe(`${f.kind} absolute → 403`);
      expect(errorOf(abs.body)).toContain('SAMMY_REQUIRE_SIGNED_TRIGGERS');
      expect(await rowsFor(mount, f.orch)).toBe(before);
    }
  });

  it('a signed trigger fires as before', async () => {
    const body = JSON.stringify({ pr: 1 });
    const res = await postJson(`${mount.baseUrl}/api/triggers/sig-hook`, { pr: 1 }, {
      'x-sammy-signature': signWebhookBody(body, SECRET),
    });
    expect(res.status).toBe(202);
  });

  it('the boot banner says so, and names each trigger the flag will refuse', () => {
    expect(banner).toContain('signed triggers: REQUIRED');
    expect(warns).toContain('"POST /api/triggers/hook1"');
    expect(warns).toContain('(hook-orch) is unsigned and will be REFUSED');
    expect(warns).toContain('"evt1" (evt-orch)');
    expect(warns).not.toContain('sig-hook');
  });
});

describe('(g) a VERIFIED read-role identity cannot fire under any spelling', () => {
  // The role gate is only a real control where the role cannot be forged —
  // a JWT deployment. So the bypass is pinned in that posture too, not only
  // with the self-declared header: one extra `/x/`, and later one `.`,
  // turned a hard 403 on a cryptographically bound `read` identity into an
  // accepted fire that started a run as that identity.
  const JWT_SECRET = 'ingress-role-jwt-secret';
  let restoreEnv: () => void;
  let mount: Mount;

  const jwtFor = (sub: string, role: string): string =>
    `Bearer ${signJwtHS256({ sub, sammy_role: role }, JWT_SECRET)}`;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_JWT_SECRET = JWT_SECRET;
    process.env.SAMMY_JWT_ROLE_CLAIM = 'sammy_role';
    mount = await mountServer(await workspace('ingress-role-jwt'));
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  it('the posture is real: the read claim is refused at /api/runs/start and the write claim is not', async () => {
    expect(
      (
        await postJson(
          `${mount.baseUrl}/api/runs/start`,
          { orchestrationName: 'hook-orch' },
          { authorization: jwtFor('carol', 'read') },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await postJson(
          `${mount.baseUrl}/api/runs/start`,
          { orchestrationName: 'hook-orch' },
          { authorization: jwtFor('dave', 'write') },
        )
      ).status,
    ).toBe(200);
  });

  it('the read claim is refused on every fire route, canonical and absolute-form', async () => {
    let seq = 0;
    for (const f of FIRES) {
      const before = await rowsFor(mount, f.orch);
      for (const target of [f.canonical, absoluteForm(mount.baseUrl, f.canonical)]) {
        seq += 1;
        const res = await rawRequest(mount.baseUrl, target, {
          method: f.method,
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `jwt-role-${seq}`,
            authorization: jwtFor('carol', 'read'),
          },
          body: f.method === 'POST' ? JSON.stringify({ n: seq }) : undefined,
        });
        expect(`${f.kind} ${target} → ${res.status}`).toBe(`${f.kind} ${target} → 403`);
        expect(errorOf(res.body)).toContain('"read" role');
      }
      expect(await rowsFor(mount, f.orch)).toBe(before);
    }
  });

  it('and every non-canonical spelling never reaches a gate at all', async () => {
    // The measured bypass: `POST /api/triggers./../hook1` with this exact
    // token answered 202 and started a run owned by `carol` — a read-only
    // identity executing an orchestration through a door that answers 403
    // one character away. The guard refuses it above the gates, so there is
    // no classification left to get wrong.
    let seq = 0;
    for (const f of FIRES) {
      const before = await rowsFor(mount, f.orch);
      for (const target of f.spellings) {
        seq += 1;
        const res = await rawRequest(mount.baseUrl, target, {
          method: f.method,
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `jwt-canon-${seq}`,
            authorization: jwtFor('carol', 'read'),
          },
          body: f.method === 'POST' ? JSON.stringify({ n: seq }) : undefined,
        });
        expect(`${f.kind} ${target} → ${res.status}`).toBe(`${f.kind} ${target} → 400`);
      }
      expect(await rowsFor(mount, f.orch)).toBe(before);
    }
    // The strongest form of the durable proof: no run is attributed to the
    // read-only claim.
    const runs = await mount.store.listRuns(50);
    expect(runs.filter(r => r.ownerId === 'carol')).toHaveLength(0);
  });

  it('a write claim still fires the canonical path (control)', async () => {
    const before = await rowsFor(mount, 'hook-orch');
    const res = await postJson(
      `${mount.baseUrl}/api/triggers/hook1`,
      { n: 99 },
      { authorization: jwtFor('dave', 'write') },
    );
    expect(res.status).toBe(202);
    expect(await rowsFor(mount, 'hook-orch')).toBe(before + 1);
  });
});

describe('(h) an odd ingress target is a 4xx, never an unauthenticated 500', () => {
  // The ingress handlers parse their own mount remainder with `new URL`, and
  // connect hands them `<protohost><remainder>` for an absolute-form target
  // without re-adding a leading slash — so `POST http://host/api/triggers.foo`
  // arrived as `http://host:<port>.foo`, an authority with an invalid port,
  // and the parse threw into the catch: 500 "Invalid URL" plus a
  // console.error, from a caller the kind-prefix exemption had waved past the
  // bearer gate. On a hardened server that is an unauthenticated error-log
  // amplifier where the non-ingress control is a clean 401.
  const TOKEN = 'ingress-5xx-token';
  let restoreEnv: () => void;
  let mount: Mount;
  const prevReads = process.env.SAMMY_REQUIRE_AUTH_READS;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_API_TOKEN = TOKEN;
    process.env.SAMMY_REQUIRE_AUTH_READS = '1';
    mount = await mountServer(await workspace('ingress-5xx'));
  });

  afterAll(async () => {
    await mount?.kill();
    if (prevReads === undefined) delete process.env.SAMMY_REQUIRE_AUTH_READS;
    else process.env.SAMMY_REQUIRE_AUTH_READS = prevReads;
    restoreEnv?.();
  });

  it('the absolute form of the "." boundary is 400, and logs nothing', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const target of [
        absoluteForm(mount.baseUrl, '/api/triggers.foo'),
        absoluteForm(mount.baseUrl, '/api/triggers./../hook1'),
        absoluteForm(mount.baseUrl, '/api/events./../evt1'),
      ]) {
        const res = await rawRequest(mount.baseUrl, target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        expect(`${target} → ${res.status}`).toBe(`${target} → 400`);
      }
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
    expect(await rowsFor(mount, 'hook-orch')).toBe(0);
    // The canonical absolute form of the same mount is unaffected: a sender
    // still fires it without the operator's bearer.
    const ok = await rawRequest(
      mount.baseUrl,
      absoluteForm(mount.baseUrl, '/api/triggers/hook1'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ n: 1 }),
      },
    );
    expect(ok.status).toBe(202);
    expect(await rowsFor(mount, 'hook-orch')).toBe(1);
  });
});
