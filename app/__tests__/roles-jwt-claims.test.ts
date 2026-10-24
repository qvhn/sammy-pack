/**
 * Role claims from a verified JWT: read only when configured, arrays and
 * dotted paths understood, garbage fails closed, absence falls through.
 *
 * Two bugs, opposite directions. (a) The claim name defaulted to `role`, so
 * a stock IdP token carrying `role: "admin"` parsed to an unrecognised value,
 * failed closed to `read`, and locked every mutation out — while the banner
 * printed "roles: not configured". (b) A non-string claim was dropped before
 * the gate, so `roles: ["read"]` — the array shape most IdPs emit — reached
 * `parseRole` as `undefined` and became the `write` default. The first
 * refused everyone; the second escalated the one identity meant to be
 * read-only.
 */

import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  postJson,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';
import { signJwtHS256 } from '../src/server/jwt-verify';

jest.setTimeout(45_000);

const SECRET = 'role-claim-secret';
const ORCH = 'role-orch';

async function mountWith(prefix: string, roleClaim?: string): Promise<Mount> {
  if (roleClaim === undefined) delete process.env.SAMMY_JWT_ROLE_CLAIM;
  else process.env.SAMMY_JWT_ROLE_CLAIM = roleClaim;
  const tmpRoot = await makeWorkspace(prefix);
  await writeOrchestration(tmpRoot, {
    name: ORCH,
    phases: [{ name: 'p', code: { source: "return 'ok';" } }],
  });
  return mountServer(tmpRoot);
}

/** A mutation as the bearer of `claims`. 200 = write; 403 = read. */
async function mutateAs(mount: Mount, claims: Record<string, unknown>): Promise<number> {
  const { status } = await postJson(
    `${mount.baseUrl}/api/runs/start`,
    { orchestrationName: ORCH },
    { authorization: `Bearer ${signJwtHS256({ sub: 'alice', ...claims }, SECRET)}` },
  );
  return status;
}

describe('JWT role claims', () => {
  let restoreEnv: () => void;
  const prevRoleClaim = process.env.SAMMY_JWT_ROLE_CLAIM;

  beforeAll(() => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_JWT_SECRET = SECRET;
  });

  afterAll(() => {
    if (prevRoleClaim === undefined) delete process.env.SAMMY_JWT_ROLE_CLAIM;
    else process.env.SAMMY_JWT_ROLE_CLAIM = prevRoleClaim;
    restoreEnv?.();
  });

  describe('with SAMMY_JWT_ROLE_CLAIM unset', () => {
    let mount: Mount;
    beforeAll(async () => {
      mount = await mountWith('role-unset');
    });
    afterAll(async () => {
      await mount?.kill();
    });

    it('does NOT read a `role` claim — a stock IdP token keeps write', async () => {
      expect(await mutateAs(mount, { role: 'admin' })).toBe(200);
      expect(await mutateAs(mount, { role: 'read' })).toBe(200);
      expect(await mutateAs(mount, { roles: ['read'] })).toBe(200);
    });
  });

  describe('with SAMMY_JWT_ROLE_CLAIM=realm_access.roles (a dotted path)', () => {
    let mount: Mount;
    beforeAll(async () => {
      mount = await mountWith('role-dotted', 'realm_access.roles');
    });
    afterAll(async () => {
      await mount?.kill();
    });

    it('an array naming read pins read', async () => {
      expect(await mutateAs(mount, { realm_access: { roles: ['read'] } })).toBe(403);
      expect(await mutateAs(mount, { realm_access: { roles: ['Everyone', 'readonly'] } })).toBe(
        403,
      );
    });

    it('an array naming write grants write (the strongest member wins)', async () => {
      expect(await mutateAs(mount, { realm_access: { roles: ['viewer', 'write'] } })).toBe(200);
    });

    it('a PRESENT but unparseable claim fails closed', async () => {
      expect(await mutateAs(mount, { realm_access: { roles: 42 } })).toBe(403);
      expect(await mutateAs(mount, { realm_access: { roles: ['nobody-knows'] } })).toBe(403);
      expect(await mutateAs(mount, { realm_access: { roles: { nested: true } } })).toBe(403);
    });

    it('an ABSENT claim falls through to the default', async () => {
      expect(await mutateAs(mount, {})).toBe(200);
      expect(await mutateAs(mount, { realm_access: {} })).toBe(200);
      expect(await mutateAs(mount, { realm_access: 'not-an-object' })).toBe(200);
    });

    it('a claim literally named with the dots wins over the path walk', async () => {
      expect(await mutateAs(mount, { 'realm_access.roles': 'read' })).toBe(403);
    });

    it('a client cannot forge the role on the header, with or without a token', async () => {
      const forged = await postJson(
        `${mount.baseUrl}/api/runs/start`,
        { orchestrationName: ORCH },
        {
          authorization: `Bearer ${signJwtHS256({ sub: 'alice', realm_access: { roles: ['read'] } }, SECRET)}`,
          'x-sammy-verified-role': 'write',
        },
      );
      expect(forged.status).toBe(403);
    });
  });
});
