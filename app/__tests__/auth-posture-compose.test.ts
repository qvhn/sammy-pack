/**
 * The auth gates COMPOSE, and ingress identity is never self-declared.
 *
 * (1) "token + verifier" — the posture SECURITY.md recommends — was
 *     unsatisfiable: the bearer gate accepted a mutation only with the static
 *     api token, the JWT gate then required that same value to be a
 *     signature-valid JWT, and no string is both. Every POST/PUT/DELETE and
 *     the gated root /metrics answered 401. Now the api token authenticates
 *     at the bearer gate (identity stays the X-Sammy-User header, as for
 *     every token caller) and the JWT gate passes it through; any other
 *     bearer is the JWT gate's to verify.
 *
 * (2) Both gates exempted trigger ingress BEFORE stripping `X-Sammy-User`,
 *     and the fire handlers record `ownerId: extractOwnerId(req)`. So an
 *     anonymous, token-less sender named any owner and the run executed AS
 *     that owner — their credentials, their per-owner spend cap. Under a
 *     gated posture an ingress fire now keeps a client-named owner only when
 *     the api token or a verified JWT vouched for the caller; otherwise it is
 *     attributed to `system`. (The open posture has nothing to authenticate
 *     against and trusts the header everywhere, ingress included — see
 *     trigger-ingress-gates for that case.)
 *
 * (3) `SAMMY_REQUIRE_AUTH_READS=yes` used to mean OFF (`=== '1'`); the flag
 *     reader now accepts the usual spellings and fails closed on garbage.
 *
 * (4) The strip in (2) is method-independent. The bearer gate's reads-open
 *     early return came BEFORE its ingress strip, so under the token-only
 *     posture with reads open (the default when only the token is set) a
 *     GET-method webhook fire — a mutation, as the cross-site guard and the
 *     role gate already classify it — kept a client-chosen owner. The JWT
 *     gate had the right ordering; the bearer gate now has it too.
 *
 * (5) The static token is compared in constant time (`===` short-circuits
 *     on the first differing byte): a wrong-length and a wrong-byte bearer
 *     are both 401, through `timingSafeEqual` over equal-length digests.
 *
 * (6) The ingress exemption is scoped to a FIRE. Both gates exempted the
 *     whole kind PREFIX, so under SAMMY_REQUIRE_AUTH_READS=1 an anonymous
 *     GET of the four bare ingress mounts answered 200 with the entire
 *     trigger inventory — fire paths, signature providers, cron exprs,
 *     polling sources — while /api/orchestrations answered 401. The
 *     exemption exists so an external SENDER can POST without the
 *     operator's bearer; a bare list is a read.
 */

import crypto from 'node:crypto';
import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  postJson,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';
import { absoluteForm, rawRequest } from './raw-request.helpers';
import { signJwtHS256 } from '../src/server/jwt-verify';

jest.setTimeout(60_000);

const TOKEN = 'compose-api-token';
const SECRET = 'compose-jwt-secret';
const ORCH = 'plain-orch';
const HOOK = 'hook1';
const GET_HOOK = 'get-hook';

async function workspace(prefix: string): Promise<string> {
  const tmpRoot = await makeWorkspace(prefix);
  await writeOrchestration(tmpRoot, {
    name: ORCH,
    phases: [{ name: 'p', code: { source: "return 'ok';" } }],
  });
  // A name a probe path is a PREFIX of: the read gate's `/health` exemption
  // must not become reachable by shortening this resource's path into it.
  await writeOrchestration(tmpRoot, {
    name: 'health-check',
    phases: [{ name: 'p', code: { source: "return 'ok';" } }],
  });
  await writeOrchestration(tmpRoot, {
    name: 'hook-orch',
    triggers: [{ kind: 'webhook', path: HOOK, method: 'POST' }],
    phases: [{ name: 'p', code: { source: "return 'ok';" } }],
  });
  // The trigger shape allows a GET-method webhook; a fire is a fire.
  await writeOrchestration(tmpRoot, {
    name: 'get-orch',
    triggers: [{ kind: 'webhook', path: GET_HOOK, method: 'GET' }],
    phases: [{ name: 'p', code: { source: "return 'ok';" } }],
  });
  return tmpRoot;
}

const jwtFor = (sub: string): string => `Bearer ${signJwtHS256({ sub }, SECRET)}`;

/** Start a run with the given headers; returns the status and the stored
 *  owner (null when no run was created). */
async function startAs(
  mount: Mount,
  headers: Record<string, string>,
): Promise<{ status: number; owner: string | null }> {
  const { status, body } = await postJson<{ id?: string }>(
    `${mount.baseUrl}/api/runs/start`,
    { orchestrationName: ORCH },
    headers,
  );
  const owner = body?.id ? ((await mount.store.getRun(body.id))?.ownerId ?? null) : null;
  return { status, owner };
}

/** Fire the webhook with the given headers; returns the status and the
 *  delivery row's owner — the identity the run will execute as. Each fire
 *  carries a distinct body, or ingress idempotency would answer the second
 *  with the FIRST delivery (200, duplicate) and mask the attribution. */
let fireSeq = 0;
async function fireAs(
  mount: Mount,
  headers: Record<string, string>,
): Promise<{ status: number; owner: string | null }> {
  fireSeq += 1;
  const { status, body } = await postJson<{ deliveryId?: string }>(
    `${mount.baseUrl}/api/triggers/${HOOK}`,
    { n: fireSeq },
    headers,
  );
  const row = body?.deliveryId
    ? (await mount.store.listDeliveries(500)).find(d => d.id === body.deliveryId)
    : undefined;
  return { status, owner: row?.ownerId ?? null };
}

/** Fire the GET-method webhook. A GET fire has no body, so the auto
 *  idempotency key collapses every fire within 60s into the FIRST delivery
 *  whatever the query string — each carries its own Idempotency-Key. */
async function fireGetAs(
  mount: Mount,
  headers: Record<string, string>,
): Promise<{ status: number; owner: string | null }> {
  fireSeq += 1;
  const res = await fetch(`${mount.baseUrl}/api/triggers/${GET_HOOK}`, {
    headers: { 'idempotency-key': `get-fire-${fireSeq}`, ...headers },
  });
  const body = (await res.json()) as { deliveryId?: string };
  const row = body?.deliveryId
    ? (await mount.store.listDeliveries(500)).find(d => d.id === body.deliveryId)
    : undefined;
  return { status: res.status, owner: row?.ownerId ?? null };
}

/** Fire through a hand-written request target — the two spellings `fetch`
 *  cannot put on the wire — and report the delivery row's owner, i.e. the
 *  identity the run would execute as. */
async function fireRawAs(
  mount: Mount,
  target: string,
  headers: Record<string, string>,
  method = 'POST',
): Promise<{ status: number; owner: string | null }> {
  fireSeq += 1;
  const res = await rawRequest(mount.baseUrl, target, {
    method,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `raw-fire-${fireSeq}`,
      ...headers,
    },
    body: method === 'POST' ? JSON.stringify({ n: fireSeq }) : undefined,
  });
  let parsed: { deliveryId?: string } = {};
  try {
    parsed = JSON.parse(res.body) as { deliveryId?: string };
  } catch {
    /* a refusal body that is not the delivery envelope */
  }
  const row = parsed.deliveryId
    ? (await mount.store.listDeliveries(500)).find(d => d.id === parsed.deliveryId)
    : undefined;
  return { status: res.status, owner: row?.ownerId ?? null };
}

describe('token + verifier (the documented posture)', () => {
  let restoreEnv: () => void;
  let mount: Mount;
  let banner = '';
  const prevReads = process.env.SAMMY_REQUIRE_AUTH_READS;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_API_TOKEN = TOKEN;
    process.env.SAMMY_JWT_SECRET = SECRET;
    // Not `1`: the flag reader must accept the ordinary spelling.
    process.env.SAMMY_REQUIRE_AUTH_READS = 'yes';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      mount = await mountServer(await workspace('compose-both'));
      banner = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    } finally {
      logSpy.mockRestore();
    }
  });

  afterAll(async () => {
    await mount?.kill();
    if (prevReads === undefined) delete process.env.SAMMY_REQUIRE_AUTH_READS;
    else process.env.SAMMY_REQUIRE_AUTH_READS = prevReads;
    restoreEnv?.();
  });

  it('the boot banner describes the combined posture', () => {
    expect(banner).toContain('require the bearer token OR a verified JWT');
    expect(banner).toContain('reads GATED (SAMMY_REQUIRE_AUTH_READS=1)');
  });

  it('a token mutation is 200, with identity from X-Sammy-User', async () => {
    const r = await startAs(mount, {
      authorization: `Bearer ${TOKEN}`,
      'x-sammy-user': 'alice',
    });
    expect(r.status).toBe(200);
    expect(r.owner).toBe('alice');
  });

  it('a verified-JWT mutation is 200, with identity from the claim (the header loses)', async () => {
    const r = await startAs(mount, {
      authorization: jwtFor('bob'),
      'x-sammy-user': 'alice',
    });
    expect(r.status).toBe(200);
    expect(r.owner).toBe('bob');
  });

  it('garbage, a forged JWT and no bearer at all are still 401', async () => {
    expect((await startAs(mount, { authorization: 'Bearer nope' })).status).toBe(401);
    expect(
      (await startAs(mount, { authorization: `Bearer ${signJwtHS256({ sub: 'x' }, 'wrong')}` }))
        .status,
    ).toBe(401);
    expect((await startAs(mount, {})).status).toBe(401);
  });

  it('gated reads: `yes` gates them; the token and a JWT both open them, root /metrics included', async () => {
    expect((await fetch(`${mount.baseUrl}/api/runs`)).status).toBe(401);
    expect((await fetch(`${mount.baseUrl}/metrics`)).status).toBe(401);
    for (const authorization of [`Bearer ${TOKEN}`, jwtFor('bob')]) {
      expect((await fetch(`${mount.baseUrl}/api/runs`, { headers: { authorization } })).status).toBe(
        200,
      );
      expect((await fetch(`${mount.baseUrl}/metrics`, { headers: { authorization } })).status).toBe(
        200,
      );
    }
  });

  describe('ingress identity', () => {
    it('an anonymous fire naming an owner is attributed to system', async () => {
      const r = await fireAs(mount, { 'x-sammy-user': 'alice' });
      expect(r.status).toBe(202);
      expect(r.owner).toBe('system');
    });

    it('a bearer that verifies as neither (a provider scheme) is tolerated, as anonymous', async () => {
      const r = await fireAs(mount, {
        authorization: 'Bearer provider-opaque-value',
        'x-sammy-user': 'alice',
      });
      expect(r.status).toBe(202);
      expect(r.owner).toBe('system');
    });

    it('the api token vouches for the header', async () => {
      const r = await fireAs(mount, {
        authorization: `Bearer ${TOKEN}`,
        'x-sammy-user': 'alice',
      });
      expect(r.status).toBe(202);
      expect(r.owner).toBe('alice');
    });

    it('a verified JWT names the owner from its claim', async () => {
      const r = await fireAs(mount, {
        authorization: jwtFor('bob'),
        'x-sammy-user': 'alice',
      });
      expect(r.status).toBe(202);
      expect(r.owner).toBe('bob');
    });

    it('a GET-method fire is stripped the same way (pinned control)', async () => {
      const r = await fireGetAs(mount, { 'x-sammy-user': 'alice' });
      expect(r.status).toBe(202);
      expect(r.owner).toBe('system');
    });

    it('the strip survives the absolute-form spelling the gates read differently', async () => {
      // The gates classified the raw mount-stripped `req.url`; an
      // absolute-form request target keeps its protohost through connect's
      // length-based mount strip, so `isIngressPath` was false, the ingress
      // branch never ran, and the client-chosen owner survived. The absolute
      // form is the one odd spelling still ADMITTED (a proxy sends it), so
      // the strip has to hold on it.
      const r = await fireRawAs(
        mount,
        absoluteForm(mount.baseUrl, `/api/triggers/${HOOK}`),
        { 'x-sammy-user': 'mallory' },
      );
      expect(`${r.status} ${r.owner}`).toBe('202 system');
    });

    it('and the non-canonical spellings never reach the handler to be stripped', async () => {
      // `/api/triggers//x/<hook>` fired <hook> through `new URL`'s
      // protocol-relative read, and `/api/triggers./../<hook>` through
      // connect's `.` mount boundary, in both cases without any gate
      // classifying the request as a fire. Both are refused above every gate
      // now, so no delivery row exists to carry an owner at all.
      const before = (await mount.store.listDeliveries(500)).length;
      for (const target of [
        `/api/triggers//x/${HOOK}`,
        `/api/triggers./../${HOOK}`,
        `/api/triggers./${HOOK}`,
      ]) {
        const r = await fireRawAs(mount, target, { 'x-sammy-user': 'mallory' });
        expect(`${target} → ${r.status} ${r.owner}`).toBe(`${target} → 400 null`);
      }
      expect((await mount.store.listDeliveries(500)).length).toBe(before);
    });

    it('and a cross-site GET fire is still refused under those spellings', async () => {
      const before = (await mount.store.listDeliveries(500)).length;
      for (const [target, status] of [
        [absoluteForm(mount.baseUrl, `/api/triggers/${GET_HOOK}`), 403],
        [`/api/triggers//x/${GET_HOOK}`, 400],
        [`/api/triggers./${GET_HOOK}`, 400],
      ] as const) {
        const r = await fireRawAs(
          mount,
          target,
          { 'sec-fetch-site': 'cross-site' },
          'GET',
        );
        expect(`${target} → ${r.status}`).toBe(`${target} → ${status}`);
      }
      expect((await mount.store.listDeliveries(500)).length).toBe(before);
    });

    it('gated reads hold under those spellings, and cannot be shortened into a probe', async () => {
      // Confinement: the gates' only path-sensitive branches are the ingress
      // and probe exemptions, so no odd spelling opens an ordinary read —
      // the admitted absolute form is gated like the origin form, and a
      // non-canonical spelling is refused before any gate reads it…
      expect(
        (await rawRequest(mount.baseUrl, absoluteForm(mount.baseUrl, '/api/runs'))).status,
      ).toBe(401);
      for (const target of ['/api//runs', '/api//orchestrations']) {
        const res = await rawRequest(mount.baseUrl, target);
        expect(`${target} → ${res.status}`).toBe(`${target} → 400`);
      }
      // …the SSE route's `?token=` lift stays on the SSE route, whatever the
      // spelling: no other read accepts a credential in its URL…
      for (const [target, status] of [
        [`/api/runs?token=${TOKEN}`, 401],
        [`/api//runs?token=${TOKEN}`, 400],
      ] as const) {
        const res = await rawRequest(mount.baseUrl, target);
        expect(`${target} → ${res.status}`).toBe(`${target} → ${status}`);
      }
      // …and the probe exemption cannot be reached by shortening another
      // resource's path into it: `new URL` resolves a `..` segment, connect's
      // mount matching does not, so a gate that resolved one would exempt
      // `/health` while the orchestrations handler answers `health-check`.
      // The guard refuses the spelling instead, so neither parser rules on it.
      const sneak = await rawRequest(mount.baseUrl, '/api/orchestrations/../health-check');
      expect(sneak.status).toBe(400);
      expect(sneak.body).not.toContain('health-check');
      // The canonical path to that same resource is gated, not exempt — the
      // control that proves the refusal above is not what hides it.
      const canonical = await rawRequest(mount.baseUrl, '/api/orchestrations/health-check');
      expect(canonical.status).toBe(401);
      expect(canonical.body).not.toContain('health-check');
      // The probes themselves are still open, and still carry no identity.
      expect((await fetch(`${mount.baseUrl}/api/livez`)).status).toBe(200);
    });
  });
});

describe('bearer token only (unchanged single posture)', () => {
  let restoreEnv: () => void;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_API_TOKEN = TOKEN;
    mount = await mountServer(await workspace('compose-token'));
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  it('token 200 / garbage 401', async () => {
    const ok = await startAs(mount, {
      authorization: `Bearer ${TOKEN}`,
      'x-sammy-user': 'alice',
    });
    expect(ok.status).toBe(200);
    expect(ok.owner).toBe('alice');
    expect((await startAs(mount, { authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('the token is compared in constant time: wrong-length and wrong-byte are both 401', async () => {
    const safeEqual = jest.spyOn(crypto, 'timingSafeEqual');
    try {
      // Same length as the real token, one byte off — the shape `===`
      // answers fastest for, and the one a timing oracle would walk.
      const wrongByte = `${TOKEN.slice(0, -1)}X`;
      expect(wrongByte).toHaveLength(TOKEN.length);
      expect((await startAs(mount, { authorization: `Bearer ${wrongByte}` })).status).toBe(401);
      expect((await startAs(mount, { authorization: `Bearer ${TOKEN}-longer` })).status).toBe(
        401,
      );
      // Both refusals went through the constant-time comparison, over
      // equal-length buffers (the hashed sides) — never a bare `===`.
      expect(safeEqual).toHaveBeenCalledTimes(2);
      for (const [a, b] of safeEqual.mock.calls) {
        expect(Buffer.isBuffer(a) && Buffer.isBuffer(b)).toBe(true);
        expect((a as Buffer).length).toBe((b as Buffer).length);
      }
      expect((await startAs(mount, { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    } finally {
      safeEqual.mockRestore();
    }
  });

  it('ingress: anonymous → system; token-authenticated → the header', async () => {
    const anon = await fireAs(mount, { 'x-sammy-user': 'alice' });
    expect(anon.status).toBe(202);
    expect(anon.owner).toBe('system');
    const vouched = await fireAs(mount, {
      authorization: `Bearer ${TOKEN}`,
      'x-sammy-user': 'alice',
    });
    expect(vouched.owner).toBe('alice');
  });

  it('an anonymous GET-method fire naming an owner is attributed to system (reads open)', async () => {
    // Reads are open here (SAMMY_REQUIRE_AUTH_READS unset), so the bearer
    // gate's read early-return used to hand a GET fire through with the
    // client-chosen header intact — no JWT gate exists in this posture to
    // strip it, and the role gate honours a write-role identity.
    const anon = await fireGetAs(mount, { 'x-sammy-user': 'mallory' });
    expect(anon.status).toBe(202);
    expect(anon.owner).toBe('system');
    // A bearer that is not the token vouches for nothing either.
    const badBearer = await fireGetAs(mount, {
      authorization: 'Bearer nope',
      'x-sammy-user': 'mallory',
    });
    expect(badBearer.status).toBe(202);
    expect(badBearer.owner).toBe('system');
    // The token still vouches for the header on a GET fire.
    const vouched = await fireGetAs(mount, {
      authorization: `Bearer ${TOKEN}`,
      'x-sammy-user': 'alice',
    });
    expect(vouched.status).toBe(202);
    expect(vouched.owner).toBe('alice');
  });

  it('an absolute-form GET fire naming an owner is attributed to system (reads open)', async () => {
    // The posture this lands in: token set, reads open.
    // No classifier matched the absolute-form target, so the bearer gate's
    // ingress branch — the strip — never ran, and the delivery was owned by
    // whatever the sender typed.
    const r = await fireRawAs(
      mount,
      absoluteForm(mount.baseUrl, `/api/triggers/${GET_HOOK}`),
      { 'x-sammy-user': 'mallory' },
      'GET',
    );
    expect(`${r.status} ${r.owner}`).toBe('202 system');
    // The non-canonical spelling of the same fire is refused outright, so
    // there is no delivery to attribute.
    const refused = await fireRawAs(
      mount,
      `/api/triggers//x/${GET_HOOK}`,
      { 'x-sammy-user': 'mallory' },
      'GET',
    );
    expect(`${refused.status} ${refused.owner}`).toBe('400 null');
    // The token still vouches for the header under the same spellings.
    const vouched = await fireRawAs(
      mount,
      absoluteForm(mount.baseUrl, `/api/triggers/${GET_HOOK}`),
      { authorization: `Bearer ${TOKEN}`, 'x-sammy-user': 'alice' },
      'GET',
    );
    expect(`${vouched.status} ${vouched.owner}`).toBe('202 alice');
  });
});

describe('JWT verifier only (unchanged single posture)', () => {
  let restoreEnv: () => void;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_JWT_SECRET = SECRET;
    mount = await mountServer(await workspace('compose-jwt'));
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  it('JWT 200 with the claim identity / garbage 401', async () => {
    const ok = await startAs(mount, { authorization: jwtFor('bob'), 'x-sammy-user': 'alice' });
    expect(ok.status).toBe(200);
    expect(ok.owner).toBe('bob');
    expect((await startAs(mount, { authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('ingress: anonymous → system; unverifiable bearer → system; verified JWT → claim', async () => {
    expect((await fireAs(mount, { 'x-sammy-user': 'alice' })).owner).toBe('system');
    expect(
      (await fireAs(mount, { authorization: 'Bearer nope', 'x-sammy-user': 'alice' })).owner,
    ).toBe('system');
    expect(
      (await fireAs(mount, { authorization: jwtFor('bob'), 'x-sammy-user': 'alice' })).owner,
    ).toBe('bob');
    // And a GET-method fire, with reads open, is stripped too (pinned control).
    expect((await fireGetAs(mount, { 'x-sammy-user': 'alice' })).owner).toBe('system');
  });
});

describe('the ingress exemption is a FIRE exemption, not an open kind prefix', () => {
  // Both gated postures: the exemption hung off the kind
  // PREFIX, above the reads check, so GET /api/{triggers,events,deploy,queue}
  // answered 200 to an anonymous caller under SAMMY_REQUIRE_AUTH_READS=1 —
  // the whole trigger registry, including every webhook path (= the fire URL)
  // and which names accept an unsigned POST — while every other read in the
  // same posture answered 401. Both gates needed narrowing: the bearer gate
  // returned early on the prefix, and the JWT gate tolerated the prefix
  // anonymously whatever the method.
  const LISTS = ['/api/triggers', '/api/triggers/', '/api/events', '/api/deploy', '/api/queue'];

  for (const posture of ['token', 'verifier'] as const) {
    describe(`${posture} + SAMMY_REQUIRE_AUTH_READS=1`, () => {
      let restoreEnv: () => void;
      let mount: Mount;
      const credential = posture === 'token' ? `Bearer ${TOKEN}` : jwtFor('bob');

      beforeAll(async () => {
        restoreEnv = pinTestEnv();
        if (posture === 'token') process.env.SAMMY_API_TOKEN = TOKEN;
        else process.env.SAMMY_JWT_SECRET = SECRET;
        process.env.SAMMY_REQUIRE_AUTH_READS = '1';
        mount = await mountServer(await workspace(`compose-ingress-list-${posture}`));
      });

      afterAll(async () => {
        await mount?.kill();
        restoreEnv?.();
      });

      it('an anonymous bare list is 401, like every other gated read', async () => {
        for (const path of LISTS) {
          const res = await fetch(`${mount.baseUrl}${path}`);
          expect(`${path} → ${res.status}`).toBe(`${path} → 401`);
          expect(await res.text()).not.toContain(HOOK);
        }
        // The control the 401s are measured against: the posture gates the
        // rest of the surface too.
        expect((await fetch(`${mount.baseUrl}/api/orchestrations`)).status).toBe(401);
      });

      it('a credentialed bare list is 200 (so the rule is not "401 everything")', async () => {
        for (const path of LISTS) {
          const res = await fetch(`${mount.baseUrl}${path}`, {
            headers: { authorization: credential },
          });
          expect(`${path} → ${res.status}`).toBe(`${path} → 200`);
        }
        const text = await (
          await fetch(`${mount.baseUrl}/api/triggers`, {
            headers: { authorization: credential },
          })
        ).text();
        expect(text).toContain(HOOK);
      });

      it("a SENDER's fire is still exempt (so the rule is not \"gate ingress wholesale\")", async () => {
        // What the exemption is for: an external sender has no operator
        // bearer, only its per-trigger HMAC. Every fire route stays open to
        // it, and the identity strip still applies.
        const post = await fireAs(mount, { 'x-sammy-user': 'mallory' });
        expect(`${post.status} ${post.owner}`).toBe('202 system');
        const get = await fireGetAs(mount, { 'x-sammy-user': 'mallory' });
        expect(`${get.status} ${get.owner}`).toBe('202 system');
      });
    });
  }
});
