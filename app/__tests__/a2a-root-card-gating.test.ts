/**
 * The root A2A discovery card honours gated reads.
 *
 * `GET /.well-known/agent-card.json` is mounted at the root, outside the
 * `/api` chain every gate is mounted on. The root `/metrics` mount is gated
 * separately for exactly that reason; the card was the other root read that
 * stayed open under the posture that promises none are. Under
 * SAMMY_REQUIRE_AUTH_READS=1 it enumerated every non-deprecated
 * orchestration's name and description (the workspace's discovery index) to
 * an anonymous caller, while /api/orchestrations, the per-orchestration card
 * and /metrics all answered 401.
 *
 * Gated with the SAME gate functions the /api mount uses, in both postures.
 * There is deliberately no public opt-out (unlike SAMMY_METRICS_PUBLIC): the
 * outbound A2A client sends no credential at all, and the per-orchestration
 * card + JSON-RPC surface it points at are already gated, so an open root
 * card bought anonymous federation nothing under this posture.
 */

import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';
import { absoluteForm, rawRequest } from './raw-request.helpers';
import { signJwtHS256 } from '../src/server/jwt-verify';

jest.setTimeout(45_000);

const TOKEN = 'card-api-token';
const SECRET = 'card-jwt-secret';
const ORCH = 'internal-pipeline';
const DESCRIPTION = 'internal: nightly reconciliation against the ledger';
const CARD = '/.well-known/agent-card.json';

async function workspace(prefix: string): Promise<string> {
  const tmpRoot = await makeWorkspace(prefix);
  await writeOrchestration(tmpRoot, {
    name: ORCH,
    description: DESCRIPTION,
    phases: [{ name: 'p', code: { source: "return 'ok';" } }],
  });
  return tmpRoot;
}

/** Mount with the given env on top of the harness baseline, capturing the
 *  boot banner. */
async function mountWith(
  prefix: string,
  env: Record<string, string>,
): Promise<{ mount: Mount; banner: string }> {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const mount = await mountServer(await workspace(prefix));
    return { mount, banner: logSpy.mock.calls.map(c => String(c[0])).join('\n') };
  } finally {
    logSpy.mockRestore();
  }
}

const statusOf = async (
  mount: Mount,
  path: string,
  authorization?: string,
): Promise<number> =>
  (await fetch(`${mount.baseUrl}${path}`, authorization ? { headers: { authorization } } : {}))
    .status;

/** The sub-paths that still reach the card through the gates' OWN /api
 *  exemptions, and so are the handler's exact-path check to refuse. connect
 *  matches a mount prefix case-insensitively, accepts `/` or `.` as the
 *  boundary, and strips the prefix by LENGTH — so inside a gate mounted here
 *  `req.url` is the remainder, and `/livez` is `isProbePath` while
 *  `/triggers/x` is an ingress FIRE, each reaching a bare `next()` with no
 *  credential checked. */
const SUB_PATHS_404 = ['/livez', '/readyz', '/health', '/triggers/x', '/LIVEZ'];

/** The sub-paths the GATE now refuses before the handler sees them: a bare
 *  ingress kind is a read, and the token exemption is scoped to a fire, so
 *  `<card>/queue` is gated like any other read under this posture. 401
 *  discloses strictly less than the 404 these answered while the exemption
 *  covered the whole kind prefix. */
const SUB_PATHS_401 = ['/queue', '/events'];

const SUB_PATHS = [...SUB_PATHS_404, ...SUB_PATHS_401];

describe('root agent card under gated reads', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = pinTestEnv();
  });
  afterEach(() => restoreEnv());

  it('token posture: anonymous 401, bad bearer 401, the token opens it', async () => {
    const { mount, banner } = await mountWith('card-token', {
      SAMMY_API_TOKEN: TOKEN,
      SAMMY_REQUIRE_AUTH_READS: '1',
    });
    try {
      // The controls the posture already gated — the card must join them.
      expect(await statusOf(mount, '/api/orchestrations')).toBe(401);
      expect(await statusOf(mount, `/api/a2a/${ORCH}/agent-card.json`)).toBe(401);
      expect(await statusOf(mount, '/metrics')).toBe(401);

      expect(await statusOf(mount, CARD)).toBe(401);
      expect(await statusOf(mount, CARD, 'Bearer nope')).toBe(401);

      const ok = await fetch(`${mount.baseUrl}${CARD}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(ok.status).toBe(200);
      const text = await ok.text();
      expect(text).toContain(ORCH);
      expect(text).toContain(DESCRIPTION);
      expect(banner).toContain('root agent card gated like /api reads');

      // The card is an EXACT path. One appended segment hit the reused
      // gates' own probe / ingress exemptions and served the whole discovery
      // index anonymously.
      for (const sub of SUB_PATHS_404) {
        const res = await fetch(`${mount.baseUrl}${CARD}${sub}`);
        expect(`${sub} → ${res.status}`).toBe(`${sub} → 404`);
        expect(await res.text()).not.toContain(ORCH);
      }
      for (const sub of SUB_PATHS_401) {
        const res = await fetch(`${mount.baseUrl}${CARD}${sub}`);
        expect(`${sub} → ${res.status}`).toBe(`${sub} → 401`);
        expect(await res.text()).not.toContain(ORCH);
      }
      // Not an alias for an authenticated caller either.
      expect(await statusOf(mount, `${CARD}/livez`, `Bearer ${TOKEN}`)).toBe(404);
      expect(await statusOf(mount, `${CARD}/queue`, `Bearer ${TOKEN}`)).toBe(404);
      // connect accepts `.` as a mount boundary too; that remainder matches
      // no exemption, so the gate refuses it before the handler would.
      expect(await statusOf(mount, `${CARD}.foo`)).toBe(401);

      // The card itself, under the two spellings `fetch` cannot emit. The
      // exact-path check used to read a hand-rolled remainder, so an
      // absolute-form target (whose protohost connect leaves in `req.url`,
      // with no leading slash re-added) and a `#` tail 404'd the resource —
      // while the gate in front of it had already classified both as the
      // resource. A forward proxy passing the absolute form through is the
      // realistic trigger.
      for (const target of [absoluteForm(mount.baseUrl, CARD), `${CARD}#x`]) {
        const anon = await rawRequest(mount.baseUrl, target);
        expect(`${target} anon → ${anon.status}`).toBe(`${target} anon → 401`);
        const authed = await rawRequest(mount.baseUrl, target, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(`${target} token → ${authed.status}`).toBe(`${target} token → 200`);
        expect(authed.body).toContain(ORCH);
      }
      // The /api chain stays correct: its gate sees `/orchestrations/...`,
      // which is neither a probe nor ingress.
      expect(await statusOf(mount, '/api/orchestrations/livez')).toBe(401);
    } finally {
      await mount.kill();
    }
  });

  it('JWT posture: anonymous 401, a verified JWT opens it', async () => {
    const { mount } = await mountWith('card-jwt', {
      SAMMY_JWT_SECRET: SECRET,
      SAMMY_REQUIRE_AUTH_READS: '1',
    });
    try {
      expect(await statusOf(mount, '/api/orchestrations')).toBe(401);
      expect(await statusOf(mount, CARD)).toBe(401);
      expect(
        await statusOf(mount, CARD, `Bearer ${signJwtHS256({ sub: 'x' }, 'wrong')}`),
      ).toBe(401);
      expect(await statusOf(mount, CARD, `Bearer ${signJwtHS256({ sub: 'bob' }, SECRET)}`)).toBe(
        200,
      );
      for (const sub of SUB_PATHS_404) {
        expect(`${sub} → ${await statusOf(mount, `${CARD}${sub}`)}`).toBe(`${sub} → 404`);
      }
      for (const sub of SUB_PATHS_401) {
        expect(`${sub} → ${await statusOf(mount, `${CARD}${sub}`)}`).toBe(`${sub} → 401`);
      }
      // The card itself under the two raw spellings, this posture's verifier.
      const jwt = `Bearer ${signJwtHS256({ sub: 'bob' }, SECRET)}`;
      for (const target of [absoluteForm(mount.baseUrl, CARD), `${CARD}#x`]) {
        expect(`${target} anon → ${(await rawRequest(mount.baseUrl, target)).status}`).toBe(
          `${target} anon → 401`,
        );
        const authed = await rawRequest(mount.baseUrl, target, {
          headers: { authorization: jwt },
        });
        expect(`${target} jwt → ${authed.status}`).toBe(`${target} jwt → 200`);
      }
    } finally {
      await mount.kill();
    }
  });

  it('stays open while reads are open (a token alone changes nothing for discovery)', async () => {
    const { mount, banner } = await mountWith('card-open', { SAMMY_API_TOKEN: TOKEN });
    try {
      expect(await statusOf(mount, CARD)).toBe(200);
      expect(banner).toContain('root agent card open');
      // Still one URI, gated or not — a sub-path is not a second spelling of
      // the well-known path. No gate is mounted here in this posture, so
      // every remainder is the handler's own 404, `/queue` included.
      for (const sub of [...SUB_PATHS, '.foo']) {
        expect(`${sub} → ${await statusOf(mount, `${CARD}${sub}`)}`).toBe(`${sub} → 404`);
      }
      // …and the card itself still serves under the raw spellings.
      for (const target of [absoluteForm(mount.baseUrl, CARD), `${CARD}#x`]) {
        expect(`${target} → ${(await rawRequest(mount.baseUrl, target)).status}`).toBe(
          `${target} → 200`,
        );
      }
    } finally {
      await mount.kill();
    }
  });
});
