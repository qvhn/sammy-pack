/**
 * Browser-side companion to the server's optional bearer-token gate.
 *
 * When the dev server has SAMMY_API_TOKEN set, state-changing /api
 * requests need `Authorization: Bearer <token>` — and under
 * SAMMY_REQUIRE_AUTH_READS=1, reads do too. The app's fetch calls are
 * spread across many files (api.ts, the run store's raw fetches, the
 * drop-to-generate modal, ...), so rather than thread a header through
 * every call site we install ONE global fetch wrapper here at app boot.
 *
 * The token is read from localStorage key `sammy.apiToken` and the user
 * id from `sammy.userId`; both are written by Settings → User identity.
 * When neither is stored — the default for local dev — the wrapper is a
 * transparent pass-through and nothing changes.
 *
 * Note: the SSE event stream uses EventSource, which can't carry custom
 * headers, and the server gate covers that GET like any other read. The
 * run store's `serverRunEventsUrl` therefore sends the SAME two values as
 * `?token=` / `?owner=` query parameters, which the server lifts into the
 * headers before its gates run — so the keys are exported from here and
 * read through `readStoredIdentity`, and the two paths cannot drift.
 */

export const TOKEN_KEY = 'sammy.apiToken';
export const USER_KEY = 'sammy.userId';

/** The stored bearer token + user id, or null for each when absent. Never
 *  throws: localStorage is missing on native and may throw in a private
 *  window, and the caller degrades to the anonymous request either way. */
export function readStoredIdentity(): {
  token: string | null;
  userId: string | null;
} {
  try {
    const ls = (
      globalThis as { localStorage?: { getItem(k: string): string | null } }
    ).localStorage;
    return {
      token: ls?.getItem(TOKEN_KEY) ?? null,
      userId: ls?.getItem(USER_KEY) ?? null,
    };
  } catch {
    return { token: null, userId: null };
  }
}

/** The base a target is resolved against when there is no `location` to
 *  compare with (native, tests). `.invalid` is reserved by RFC 2606 and can
 *  never be served, so "still on this origin after parsing" is a property of
 *  the target rather than a list of the spellings that would leave it. */
const NO_LOCATION_BASE = 'http://sammy-pack.invalid/';
const NO_LOCATION_ORIGIN = 'http://sammy-pack.invalid';

/** Is this a request to OUR `/api/` — the only kind that may carry the
 *  operator's bearer token and user id? Matching `'/api/'` anywhere in the
 *  URL sent them to any host whose path happened to contain it, and the
 *  token is the admin credential for everything the server guards. The
 *  URL is resolved against the page (a `Request` object's `.url` is always
 *  absolute, and `http://<this host>/api/…` from the page itself must still
 *  count) and must share its origin; a relative path can only reach the
 *  page's own origin, so without a `location` (native, tests) that is the
 *  one form accepted. */
export function isSameOriginApi(url: string): boolean {
  const loc = (globalThis as { location?: { href?: string; origin?: string } })
    .location;
  const pageOrigin = typeof loc?.origin === 'string' ? loc.origin : null;
  let target: URL;
  try {
    target = new URL(
      url,
      pageOrigin === null ? NO_LOCATION_BASE : (loc?.href ?? pageOrigin),
    );
  } catch {
    return false;
  }
  if (!target.pathname.startsWith('/api/')) return false;
  if (pageOrigin !== null) return target.origin === pageOrigin;
  // No origin to compare against, so accept only a root-relative path — and
  // decide "root-relative" from the PARSED result, not the raw string. Any
  // test on the string is an enumeration of spellings: rejecting `//` and a
  // scheme missed the backslash forms (the parser maps `\` to `/` for a
  // special scheme), and rejecting those missed the ASCII tab / LF / CR the
  // parser STRIPS from anywhere in the input before it reads the authority,
  // so `/<TAB>/evil/api/x` read as root-relative and `fetch` reached
  // `http://evil/api/x`. A target that still sits on a base no attacker can
  // be served from could not have named a host, however it was spelled.
  return url.startsWith('/') && target.origin === NO_LOCATION_ORIGIN;
}

export function installApiAuth(): void {
  const g = globalThis as unknown as { fetch?: typeof fetch };
  if (typeof g.fetch !== 'function') return;
  const realFetch = g.fetch.bind(globalThis);

  g.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const { token, userId } = readStoredIdentity();
    if (!token && !userId) return realFetch(input, init);

    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!isSameOriginApi(url)) return realFetch(input, init);

    const headers = new Headers(init?.headers ?? {});
    if (token && !headers.has('authorization')) {
      headers.set('authorization', `Bearer ${token}`);
    }
    // Multi-tenancy seam — scope reads/writes to this user. When
    // unset, the server falls back to the 'system' default.
    if (userId && !headers.has('x-sammy-user')) {
      headers.set('x-sammy-user', userId);
    }
    return realFetch(input, { ...init, headers });
  }) as typeof fetch;
}
