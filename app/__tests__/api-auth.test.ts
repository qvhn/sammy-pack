/**
 * Tests for the browser-side bearer-token fetch wrapper. We install it
 * over a stubbed globalThis.fetch + localStorage and assert it attaches
 * the Authorization header only to same-origin /api requests, only
 * when a token is stored.
 */

import { installApiAuth, isSameOriginApi } from '../web/api-auth';

type FetchCall = { url: string; init?: RequestInit };

function setupWithUser(token: string | null, userId: string | null) {
  const calls: FetchCall[] = [];
  const realFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    calls.push({ url, init });
    return Promise.resolve(new Response('ok'));
  }) as typeof fetch;

  const g = globalThis as unknown as {
    fetch: typeof fetch;
    localStorage: { getItem(k: string): string | null };
  };
  const prevFetch = g.fetch;
  g.fetch = realFetch;
  g.localStorage = {
    getItem: (k: string) =>
      k === 'sammy.apiToken' ? token : k === 'sammy.userId' ? userId : null,
  };
  installApiAuth();
  return {
    calls,
    restore: () => {
      g.fetch = prevFetch;
    },
  };
}

function setup(token: string | null) {
  const calls: FetchCall[] = [];
  const realFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    calls.push({ url, init });
    return Promise.resolve(new Response('ok'));
  }) as typeof fetch;

  const g = globalThis as unknown as {
    fetch: typeof fetch;
    localStorage: { getItem(k: string): string | null };
  };
  const prevFetch = g.fetch;
  g.fetch = realFetch;
  g.localStorage = {
    getItem: (k: string) => (k === 'sammy.apiToken' ? token : null),
  };
  installApiAuth();
  return {
    calls,
    restore: () => {
      g.fetch = prevFetch;
    },
  };
}

function authOf(init?: RequestInit): string | null {
  if (!init?.headers) return null;
  const h = new Headers(init.headers);
  return h.get('authorization');
}

describe('installApiAuth', () => {
  it('attaches the bearer token to same-origin /api requests', async () => {
    const { calls, restore } = setup('secret-123');
    await fetch('/api/runs/start', { method: 'POST' });
    expect(authOf(calls[0].init)).toBe('Bearer secret-123');
    restore();
  });

  it('does NOT attach the token to non-/api URLs', async () => {
    const { calls, restore } = setup('secret-123');
    await fetch('https://api.example.com/v1/things', { method: 'POST' });
    expect(authOf(calls[0].init)).toBeNull();
    restore();
  });

  it('is a pass-through when no token is stored', async () => {
    const { calls, restore } = setup(null);
    await fetch('/api/runs/start', { method: 'POST' });
    expect(authOf(calls[0].init)).toBeNull();
    restore();
  });

  it('does not overwrite an Authorization header the caller already set', async () => {
    const { calls, restore } = setup('secret-123');
    await fetch('/api/runs/start', {
      method: 'POST',
      headers: { authorization: 'Bearer caller-set' },
    });
    expect(authOf(calls[0].init)).toBe('Bearer caller-set');
    restore();
  });

  it('attaches X-Sammy-User to /api requests when a user id is stored', async () => {
    const { calls, restore } = setupWithUser(null, 'alice');
    await fetch('/api/runs', { method: 'GET' });
    const headers = new Headers(calls[0].init?.headers ?? {});
    expect(headers.get('x-sammy-user')).toBe('alice');
    restore();
  });

  it('does NOT attach X-Sammy-User to non-/api URLs', async () => {
    const { calls, restore } = setupWithUser(null, 'alice');
    await fetch('https://api.example.com/v1/things', { method: 'POST' });
    const headers = new Headers(calls[0].init?.headers ?? {});
    expect(headers.get('x-sammy-user')).toBeNull();
    restore();
  });

  it('attaches BOTH token and user id when both are stored', async () => {
    const { calls, restore } = setupWithUser('secret-123', 'alice');
    await fetch('/api/runs', { method: 'POST' });
    const headers = new Headers(calls[0].init?.headers ?? {});
    expect(headers.get('authorization')).toBe('Bearer secret-123');
    expect(headers.get('x-sammy-user')).toBe('alice');
    restore();
  });
});

/** The token is the admin credential for everything the server guards, so
 *  it may only travel to OUR `/api/`. Before: any URL containing `/api/`
 *  qualified, so a fetch to a third-party host whose path happened to
 *  contain it carried the operator's token and user id. */
describe('installApiAuth — the identity never leaves the page\'s origin', () => {
  const g = globalThis as { location?: unknown };
  let prevLocation: unknown;
  beforeEach(() => {
    prevLocation = g.location;
  });
  afterEach(() => {
    g.location = prevLocation;
  });

  function identityOf(init?: RequestInit) {
    const h = new Headers(init?.headers ?? {});
    return { auth: h.get('authorization'), user: h.get('x-sammy-user') };
  }

  it('does NOT attach the token or user id to a foreign origin whose path contains /api/', async () => {
    const { calls, restore } = setupWithUser('secret-123', 'alice');
    await fetch('https://other.example.test/api/runs', { method: 'POST' });
    expect(identityOf(calls[0].init)).toEqual({ auth: null, user: null });
    restore();
  });

  it('nor to a protocol-relative URL (it resolves to another host)', async () => {
    const { calls, restore } = setupWithUser('secret-123', 'alice');
    await fetch('//other.example.test/api/runs', { method: 'POST' });
    expect(identityOf(calls[0].init)).toEqual({ auth: null, user: null });
    restore();
  });

  it('attaches to an absolute URL and a Request on the page\'s own origin, and still not to another', async () => {
    g.location = { href: 'http://localhost:5174/runs', origin: 'http://localhost:5174' };
    const { calls, restore } = setupWithUser('secret-123', 'alice');
    await fetch('http://localhost:5174/api/runs', { method: 'POST' });
    // What a `fetch(new Request('/api/…'))` from the page looks like: the
    // Request's url is already absolute.
    await fetch(new Request('http://localhost:5174/api/credentials'));
    await fetch('https://other.example.test/api/runs', { method: 'POST' });
    await fetch('/api/runs', { method: 'GET' });
    expect(identityOf(calls[0].init)).toEqual({ auth: 'Bearer secret-123', user: 'alice' });
    expect(identityOf(calls[1].init)).toEqual({ auth: 'Bearer secret-123', user: 'alice' });
    expect(identityOf(calls[2].init)).toEqual({ auth: null, user: null });
    expect(identityOf(calls[3].init)).toEqual({ auth: 'Bearer secret-123', user: 'alice' });
    restore();
  });

  it('is not fooled by a same-origin path that merely contains /api/', async () => {
    const { calls, restore } = setupWithUser('secret-123', 'alice');
    await fetch('/docs/api/reference.html');
    expect(identityOf(calls[0].init)).toEqual({ auth: null, user: null });
    restore();
  });

  it('with no origin to compare against, accepts ONLY a root-relative path', () => {
    // The native / test branch has no `location`, so it cannot compare
    // origins. Enumerating the bad prefixes there (`//`, a scheme) missed
    // the backslash spellings: the URL parser maps `\` to `/` for a special
    // scheme, so these resolve to `http://evil/api/x` — pathname `/api/x` —
    // and passed the very test the `//` form is rejected by.
    const g = globalThis as { location?: unknown };
    const had = 'location' in g;
    const prev = g.location;
    delete g.location;
    try {
      expect(isSameOriginApi('/api/runs')).toBe(true);
      for (const url of [
        '//evil.example.test/api/x',
        '\\\\evil.example.test/api/x',
        '/\\evil.example.test/api/x',
        '\\/evil.example.test/api/x',
        'https://evil.example.test/api/x',
        'HTTP://evil.example.test/api/x',
        '/docs/api/x',
        'api/runs',
      ]) {
        expect(isSameOriginApi(url)).toBe(false);
      }
    } finally {
      if (had) g.location = prev;
    }
  });

  it('and is not fooled by the tab / LF / CR the URL parser strips', () => {
    // The WHATWG parser removes every ASCII tab, LF and CR from ANYWHERE in
    // the input before it reads the authority, so each of these is
    // root-relative to any test on the raw string — and
    // `http://evil.example.test/api/x` to `fetch`. Rejecting the enumerated
    // `//` and `\` prefixes was never the property; "the parsed target is
    // still on a base no attacker can be served from" is.
    const g = globalThis as { location?: unknown };
    const had = 'location' in g;
    const prev = g.location;
    delete g.location;
    try {
      for (const url of [
        '/\t/evil.example.test/api/x',
        '/\n/evil.example.test/api/x',
        '/\r/evil.example.test/api/x',
        '/\t\\evil.example.test/api/x',
        '/\t\t//evil.example.test/api/x',
      ]) {
        // The leak this guards: the stripped spelling is a foreign origin.
        expect(new URL(url, 'http://sammy-pack.invalid/').origin).toBe(
          'http://evil.example.test',
        );
        expect(isSameOriginApi(url)).toBe(false);
      }
      // Still accepted: the forms that genuinely cannot name a host.
      expect(isSameOriginApi('/api/runs')).toBe(true);
      expect(isSameOriginApi('/api/runs?token=x#y')).toBe(true);
    } finally {
      if (had) g.location = prev;
    }
  });
});
