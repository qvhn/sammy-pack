/**
 * Read / write role enforcement.
 *
 * Identity answered *who* (owner scoping, plus JWT verification on top). It
 * never answered *what they may do*: anything past the bearer gate could
 * mutate, and there was no way to hand a teammate a view-only credential.
 *
 * Two roles by design — `read` (GET/HEAD/OPTIONS) and `write` (everything) —
 * driven entirely by configuration. There is no user store and no account
 * creation: a role comes from a verified JWT claim, or from an owner-id
 * allowlist, or defaults to `write` so an existing single-user deployment is
 * unchanged.
 *
 * Both halves are tested, because either alone is a trap: a gate that refuses
 * everything is as broken as one that refuses nothing.
 */

import {
  claimAtPath,
  effectiveRole,
  isReadMethod,
  parseRole,
  roleAllowsMethod,
  rolesConfigured,
} from '../src/server/roles';
import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(30_000);

describe('role resolution', () => {
  // Pure functions, but they read the live env: an ambient
  // SAMMY_READONLY_USERS in the developer's shell made "unconfigured"
  // report as configured. Same pin the mounted cases use.
  let restoreEnv: () => void;
  beforeAll(() => {
    restoreEnv = pinTestEnv();
  });
  afterAll(() => restoreEnv?.());
  afterEach(() => {
    delete process.env.SAMMY_READONLY_USERS;
    delete process.env.SAMMY_JWT_ROLE_CLAIM;
  });

  it('defaults to write so an unconfigured deployment is unchanged', () => {
    expect(effectiveRole({ ownerId: 'anyone' })).toBe('write');
    expect(rolesConfigured()).toBe(false);
  });

  it('pins an owner listed in SAMMY_READONLY_USERS to read', () => {
    process.env.SAMMY_READONLY_USERS = 'viewer, auditor';
    expect(effectiveRole({ ownerId: 'viewer' })).toBe('read');
    expect(effectiveRole({ ownerId: 'auditor' })).toBe('read');
    expect(effectiveRole({ ownerId: 'operator' })).toBe('write');
    expect(rolesConfigured()).toBe(true);
  });

  it('lets a VERIFIED claim win over the allowlist', () => {
    // The claim is signed; the allowlist is a convenience for deployments with
    // no token at all. Signed evidence beats local config.
    process.env.SAMMY_READONLY_USERS = 'viewer';
    expect(effectiveRole({ ownerId: 'viewer', claimRole: 'write' })).toBe('write');
    expect(effectiveRole({ ownerId: 'operator', claimRole: 'read' })).toBe('read');
  });

  it('fails CLOSED on an unrecognised role value', () => {
    // A typo in a claim must downgrade, never escalate: `"Writer"` is not
    // `write`, and treating "unknown" as the default would make a typo an
    // escalation.
    for (const bad of ['Writer', 'rw', 'admin', 'owner', '']) {
      expect(effectiveRole({ ownerId: 'x', claimRole: bad })).toBe('read');
    }
    // ABSENT (undefined / null) falls through to the allowlist/default.
    // PRESENT but not a string or array — a number, an object — is
    // unparseable, and unparseable fails closed. Treating it as absent is
    // what let an array claim escalate to the `write` default.
    expect(parseRole(undefined)).toBeNull();
    expect(parseRole(null)).toBeNull();
    expect(parseRole(42)).toBe('read');
    expect(parseRole({ nested: true })).toBe('read');
    expect(parseRole(true)).toBe('read');
    expect(effectiveRole({ ownerId: 'x', claimRole: undefined })).toBe('write');
    expect(effectiveRole({ ownerId: 'x', claimRole: 42 })).toBe('read');
  });

  it('understands the array shape most identity providers emit', () => {
    expect(parseRole(['read'])).toBe('read');
    expect(parseRole(['Everyone', 'readonly'])).toBe('read');
    // The strongest recognised member wins.
    expect(parseRole(['viewer', 'write'])).toBe('write');
    expect(parseRole(['read', 'read-write'])).toBe('write');
    // Present, but no member is a known role: fail closed, not default.
    expect(parseRole(['admin', 'owner'])).toBe('read');
    expect(parseRole([])).toBe('read');
    expect(parseRole([42, null])).toBe('read');
    expect(effectiveRole({ ownerId: 'x', claimRole: ['read'] })).toBe('read');
    expect(effectiveRole({ ownerId: 'x', claimRole: ['write'] })).toBe('write');
  });

  it('reads a claim by name or by dotted path', () => {
    const claims = {
      role: 'read',
      realm_access: { roles: ['write'] },
      'realm_access.roles': 'read',
      resource_access: { api: { roles: ['read'] } },
    };
    expect(claimAtPath(claims, 'role')).toBe('read');
    expect(claimAtPath(claims, 'resource_access.api.roles')).toEqual(['read']);
    // A claim literally named with the dots wins over the path walk.
    expect(claimAtPath(claims, 'realm_access.roles')).toBe('read');
    // Absent at any depth is `undefined` — the one value that falls through.
    expect(claimAtPath(claims, 'nope')).toBeUndefined();
    expect(claimAtPath(claims, 'realm_access.nope')).toBeUndefined();
    expect(claimAtPath(claims, 'role.deeper')).toBeUndefined();
    expect(claimAtPath({ realm_access: null }, 'realm_access.roles')).toBeUndefined();
    expect(claimAtPath({ realm_access: ['x'] }, 'realm_access.0')).toBeUndefined();
  });

  it('accepts the common spellings', () => {
    expect(parseRole('read-only')).toBe('read');
    expect(parseRole('READONLY')).toBe('read');
    expect(parseRole('readWrite')).toBe('write');
  });

  it('classifies methods', () => {
    expect(isReadMethod('GET')).toBe(true);
    expect(isReadMethod('head')).toBe(true);
    expect(isReadMethod('POST')).toBe(false);
    expect(roleAllowsMethod('read', 'GET')).toBe(true);
    expect(roleAllowsMethod('read', 'DELETE')).toBe(false);
    expect(roleAllowsMethod('write', 'DELETE')).toBe(true);
  });
});

describe('the role gate over the mounted API', () => {
  let restoreEnv: () => void;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    const tmpRoot = await makeWorkspace('roles');
    await writeOrchestration(tmpRoot, {
      name: 'role-orch',
      phases: [{ name: 'p', code: { source: "return 'ok';" } }],
    });
    process.env.SAMMY_READONLY_USERS = 'viewer';
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    delete process.env.SAMMY_READONLY_USERS;
    restoreEnv?.();
  });

  const as = (owner: string): Record<string, string> => ({
    'content-type': 'application/json',
    'x-sammy-user': owner,
  });

  it('a read-role identity can READ', async () => {
    const res = await fetch(`${mount.baseUrl}/api/runs`, {
      headers: { 'x-sammy-user': 'viewer' },
    });
    expect(res.status).toBe(200);
  });

  it('a read-role identity is refused a WRITE, with an actionable message', async () => {
    const res = await fetch(`${mount.baseUrl}/api/runs/start`, {
      method: 'POST',
      headers: as('viewer'),
      body: JSON.stringify({ orchestrationName: 'role-orch' }),
    });
    expect(res.status).toBe(403);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('read');
    // Names the two levers, so the operator knows where the role came from.
    expect(error).toContain('SAMMY_READONLY_USERS');
  });

  it('refuses DELETE too, not just POST', async () => {
    const res = await fetch(`${mount.baseUrl}/api/runs/whatever`, {
      method: 'DELETE',
      headers: as('viewer'),
    });
    expect(res.status).toBe(403);
  });

  it('a write-role identity is unaffected', async () => {
    const res = await fetch(`${mount.baseUrl}/api/runs/start`, {
      method: 'POST',
      headers: as('operator'),
      body: JSON.stringify({ orchestrationName: 'role-orch' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string | null }).id).toBeTruthy();
  });

  it('a client cannot forge the verified-role header', async () => {
    // The role gate reads an INTERNAL header that only the JWT verifier sets.
    // It is stripped from every inbound request first, so sending it is inert.
    const res = await fetch(`${mount.baseUrl}/api/runs/start`, {
      method: 'POST',
      headers: { ...as('viewer'), 'x-sammy-verified-role': 'write' },
      body: JSON.stringify({ orchestrationName: 'role-orch' }),
    });
    expect(res.status).toBe(403);
  });

  it('leaves health probes reachable for an orchestrator', async () => {
    // A probe has no identity and must never be gated — otherwise a
    // readiness check fails for an authorization reason.
    for (const p of ['livez', 'readyz', 'health']) {
      const res = await fetch(`${mount.baseUrl}/api/${p}`, {
        headers: { 'x-sammy-user': 'viewer' },
      });
      expect(res.status).toBe(200);
    }
  });
});
