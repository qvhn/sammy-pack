/**
 * roles — a two-role authorization model: `read` and `write`.
 *
 * Identity answered *who* (the `owner_id` seam, and JWT verification on top of
 * it). It never answered *what they may do*: any caller that got past the
 * bearer gate could mutate anything they owned, and there was no way to hand
 * someone a view-only credential. For a shared deployment that is the
 * difference between "a teammate can watch the pipeline" and "a teammate can
 * cancel production runs".
 *
 * Deliberately TWO roles, not a permission matrix:
 *
 *   read   — GET / HEAD / OPTIONS only. Every mutation is refused 403.
 *   write  — everything (reads included). The existing behaviour.
 *
 * Two roles cover the real split (observer vs. operator) with a model small
 * enough to reason about, and leave room for a finer scheme later without
 * having guessed at one now. There is intentionally no "admin": owner scoping
 * already partitions data, and a third tier would imply cross-owner powers
 * that nothing in the store grants.
 *
 * ── Where a role comes from ──────────────────────────────────────────────
 *   1. A verified JWT claim, named by `SAMMY_JWT_ROLE_CLAIM` — the only
 *      trustworthy source, because the token is signed. ONLY read when the
 *      variable is explicitly set: there is no default claim name, because a
 *      stock IdP token routinely carries `role: "admin"` or
 *      `roles: ["Everyone"]`, and reading that by default would fail every
 *      mutation closed on a server whose banner says roles are not
 *      configured. The name may be a dotted path (`realm_access.roles`) and
 *      the claim may be a string OR an array of strings.
 *   2. `SAMMY_READONLY_USERS`: a list of owner ids pinned to `read`. The
 *      pragmatic path for a deployment using the bearer token + the
 *      `X-Sammy-User` header, where there is no signed claim to read.
 *   3. Default `write`, so nothing changes for an existing single-user
 *      deployment that configures neither.
 *
 * PRESENT vs ABSENT is the line that matters for a claim: an ABSENT claim
 * falls through to the allowlist and the default; a PRESENT claim that cannot
 * be understood — an unknown string, an array naming no known role, a number,
 * an object — fails CLOSED to `read`. Previously a non-string claim was
 * treated as absent, so `role: ["read"]` (the array shape most IdPs emit)
 * silently granted `write`.
 *
 * HONESTY NOTE, because this is easy to oversell: with reads ungated and
 * identity taken from a client-supplied header, a caller can simply send a
 * different `X-Sammy-User` and get `write`. Role enforcement is only a
 * security control under `SAMMY_REQUIRE_AUTH_READS=1` with a JWT verifier —
 * exactly the same precondition owner scoping has. Without that it is a
 * guardrail against accident, not against an adversary, and the boot banner
 * says which one is in effect.
 */

import { envList } from './env';

export type Role = 'read' | 'write';

/** Methods that do not mutate state. Mirrors the auth gates' own split. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isReadMethod(method: string | undefined): boolean {
  return READ_METHODS.has((method ?? 'GET').toUpperCase());
}

/** One recognised spelling → a role; null for anything else. */
function roleOfWord(raw: string): Role | null {
  const v = raw.trim().toLowerCase();
  if (v === 'write' || v === 'readwrite' || v === 'read-write') return 'write';
  if (v === 'read' || v === 'readonly' || v === 'read-only') return 'read';
  return null;
}

/** Parse a role from an untrusted claim value. Returns null ONLY when the
 *  claim is absent (`undefined` / `null`) so the caller falls through to the
 *  allowlist and the default. Anything PRESENT but unrecognised is `read` —
 *  failing CLOSED, so a typo in a claim (`"Writer"`, `"rw"`) downgrades to
 *  view-only rather than silently granting mutation.
 *
 *  Arrays are the shape most identity providers emit (`roles: ["read"]`,
 *  `realm_access.roles: [...]`): the strongest recognised member wins — any
 *  `write` spelling grants write, else any `read` spelling pins read, else
 *  (no member is a known role) it fails closed to `read`. A non-string,
 *  non-array value (a number, an object) is present and unparseable, so it
 *  is `read` too — treating it as absent is what let an array claim escalate
 *  to the `write` default. */
export function parseRole(raw: unknown): Role | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') return roleOfWord(raw) ?? 'read';
  if (Array.isArray(raw)) {
    for (const member of raw) {
      if (typeof member === 'string' && roleOfWord(member) === 'write') {
        return 'write';
      }
    }
    // `read` whether a member said so or none was recognised: present but
    // not understood must not become the default.
    return 'read';
  }
  // Present but unparseable (number / object / boolean): fail closed.
  return 'read';
}

/** Read a claim by name OR by dotted path (`realm_access.roles`) from a
 *  verified claim set. A claim literally named with the dots wins over the
 *  path walk, so a flat token is never misread. `undefined` means absent —
 *  the one value {@link parseRole} treats as "fall through". */
export function claimAtPath(
  claims: Record<string, unknown>,
  name: string,
): unknown {
  if (Object.prototype.hasOwnProperty.call(claims, name)) return claims[name];
  if (!name.includes('.')) return undefined;
  let cur: unknown = claims;
  for (const seg of name.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Owner ids pinned to `read` via `SAMMY_READONLY_USERS` (comma/space/semicolon
 *  separated). Read at each use so a test can set it. */
export function readOnlyOwners(): Set<string> {
  return new Set(envList('SAMMY_READONLY_USERS'));
}

/**
 * The effective role for a request.
 *
 * `claimRole` is the already-verified JWT claim when one was present — it
 * wins, because it is the only signed source. Otherwise the owner-id
 * allowlist decides, and the default is `write`.
 */
export function effectiveRole(opts: {
  ownerId: string;
  claimRole?: unknown;
}): Role {
  const fromClaim = parseRole(opts.claimRole);
  if (fromClaim) return fromClaim;
  return readOnlyOwners().has(opts.ownerId) ? 'read' : 'write';
}

/** True when `role` may perform `method`. */
export function roleAllowsMethod(role: Role, method: string | undefined): boolean {
  return role === 'write' || isReadMethod(method);
}

/** Whether any role configuration is in effect at all — for the boot banner,
 *  so an operator can see at a glance whether roles are doing anything. */
export function rolesConfigured(): boolean {
  return (
    readOnlyOwners().size > 0 ||
    (process.env.SAMMY_JWT_ROLE_CLAIM ?? '').trim() !== ''
  );
}
