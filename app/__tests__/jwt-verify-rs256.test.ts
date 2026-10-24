import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  createJwksClient,
  decodeJwtHeader,
  signJwtHS256,
  signJwtRS256,
  verifyJwtRS256,
} from '../src/server/jwt-verify';

// Two independent RSA keypairs — one is the issuer, the other is "wrong".
const issuer = generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });

const pubPem = issuer.publicKey.export({ type: 'spki', format: 'pem' }) as string;

/** A JWKS entry from a public key, with a kid. */
function jwk(pub: KeyObject, kid: string) {
  return { ...(pub.export({ format: 'jwk' }) as object), kid, use: 'sig', alg: 'RS256' };
}

describe('verifyJwtRS256', () => {
  it('accepts a token signed by the matching private key (KeyObject + PEM + JWK)', () => {
    const tok = signJwtRS256({ sub: 'alice', role: 'admin' }, issuer.privateKey);
    for (const key of [
      issuer.publicKey,
      pubPem,
      issuer.publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
    ]) {
      const r = verifyJwtRS256(tok, key);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.claims.sub).toBe('alice');
    }
  });

  it('rejects a token signed by a different key (signature mismatch)', () => {
    const tok = signJwtRS256({ sub: 'alice' }, attacker.privateKey);
    expect(verifyJwtRS256(tok, issuer.publicKey)).toEqual({
      ok: false,
      reason: 'signature mismatch',
    });
  });

  it('rejects a tampered payload', () => {
    const tok = signJwtRS256({ sub: 'alice' }, issuer.privateKey);
    const [h, , s] = tok.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'mallory' }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifyJwtRS256(`${h}.${forged}.${s}`, issuer.publicKey).ok).toBe(false);
  });

  it('refuses an HS256 token (no alg-confusion downgrade)', () => {
    const hs = signJwtHS256({ sub: 'mallory' }, 'shared-secret');
    const r = verifyJwtRS256(hs, issuer.publicKey);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/RS256 only/);
  });

  it('honors exp / nbf', () => {
    const expd = signJwtRS256({ sub: 'a', exp: 1000 }, issuer.privateKey);
    expect(verifyJwtRS256(expd, issuer.publicKey, { now: 2_000_000 }).ok).toBe(false);
    expect(verifyJwtRS256(expd, issuer.publicKey, { now: 500_000 }).ok).toBe(true);
    const future = signJwtRS256({ sub: 'a', nbf: 5000 }, issuer.privateKey);
    expect(verifyJwtRS256(future, issuer.publicKey, { now: 1_000_000 }).ok).toBe(false);
  });

  it('rejects a non-RSA public key', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const tok = signJwtRS256({ sub: 'a' }, issuer.privateKey);
    const r = verifyJwtRS256(tok, ec.publicKey);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/expected rsa/);
  });
});

describe('decodeJwtHeader', () => {
  it('reads alg + kid without verifying', () => {
    const tok = signJwtRS256({ sub: 'a' }, issuer.privateKey, { kid: 'key-1' });
    expect(decodeJwtHeader(tok)).toMatchObject({ alg: 'RS256', kid: 'key-1' });
  });
  it('returns null for a malformed token', () => {
    expect(decodeJwtHeader('not.a')).toBeNull();
  });
});

describe('createJwksClient', () => {
  /** A fetch stub serving a fixed JWKS; counts calls so we can assert caching. */
  function stubJwks(keys: object[]) {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ keys }),
      } as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, calls: () => calls };
  }

  it('verifies a token whose kid is in the JWKS', async () => {
    const stub = stubJwks([jwk(issuer.publicKey, 'key-1')]);
    const client = createJwksClient({ jwksUri: 'https://issuer/jwks', fetchImpl: stub.fetchImpl });
    const tok = signJwtRS256({ sub: 'alice' }, issuer.privateKey, { kid: 'key-1' });
    const r = await client.verify(tok);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims.sub).toBe('alice');
  });

  it('caches keys — a second verify does not refetch', async () => {
    const stub = stubJwks([jwk(issuer.publicKey, 'key-1')]);
    const client = createJwksClient({ jwksUri: 'https://issuer/jwks', fetchImpl: stub.fetchImpl });
    const tok = signJwtRS256({ sub: 'a' }, issuer.privateKey, { kid: 'key-1' });
    await client.verify(tok);
    await client.verify(tok);
    expect(stub.calls()).toBe(1);
  });

  it('refetches on an unknown kid (key rotation)', async () => {
    // Server initially serves key-1; later rotates to a brand-new key-2.
    let keys = [jwk(issuer.publicKey, 'key-1')];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ keys }) } as Response;
    }) as unknown as typeof fetch;
    const client = createJwksClient({
      jwksUri: 'https://issuer/jwks',
      fetchImpl,
      minRefetchMs: 0,
    });
    // First token: key-1 — caches the JWKS (one fetch).
    const tok1 = signJwtRS256({ sub: 'a' }, issuer.privateKey, { kid: 'key-1' });
    expect((await client.verify(tok1)).ok).toBe(true);
    expect(calls).toBe(1);

    // Rotation: the issuer swaps in a new signing key under a new kid.
    const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
    keys = [jwk(rotated.publicKey, 'key-2')];
    const tok2 = signJwtRS256({ sub: 'b' }, rotated.privateKey, { kid: 'key-2' });
    const r = await client.verify(tok2); // unseen kid -> refetch
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims.sub).toBe('b');
    expect(calls).toBe(2);
  });

  it('throttles refetch on a flood of bogus kids (minRefetchMs)', async () => {
    const stub = stubJwks([jwk(issuer.publicKey, 'key-1')]);
    const client = createJwksClient({
      jwksUri: 'https://issuer/jwks',
      fetchImpl: stub.fetchImpl,
      minRefetchMs: 60_000,
    });
    const bogus = signJwtRS256({ sub: 'x' }, attacker.privateKey, { kid: 'nope' });
    const r1 = await client.verify(bogus); // first miss fetches once
    const r2 = await client.verify(bogus); // within window -> no refetch
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(stub.calls()).toBe(1);
  });

  it('fails closed when the JWKS endpoint errors', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 503, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    const client = createJwksClient({ jwksUri: 'https://issuer/jwks', fetchImpl });
    const tok = signJwtRS256({ sub: 'a' }, issuer.privateKey, { kid: 'key-1' });
    const r = await client.verify(tok);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/JWKS fetch failed: HTTP 503/);
  });

  it('uses the sole key for a token that omits kid', async () => {
    const stub = stubJwks([jwk(issuer.publicKey, 'only')]);
    const client = createJwksClient({ jwksUri: 'https://issuer/jwks', fetchImpl: stub.fetchImpl });
    const tok = signJwtRS256({ sub: 'nokid' }, issuer.privateKey); // no kid
    const r = await client.verify(tok);
    expect(r.ok).toBe(true);
  });
});

describe('claim validation (aud / iss / iat)', () => {
  const sign = (claims: Record<string, unknown>) =>
    signJwtRS256(claims, issuer.privateKey);

  it('accepts when audience + issuer match', () => {
    const tok = sign({ sub: 'a', aud: 'sammy', iss: 'https://idp' });
    expect(
      verifyJwtRS256(tok, issuer.publicKey, {
        audience: 'sammy',
        issuer: 'https://idp',
      }).ok,
    ).toBe(true);
  });

  it('accepts when aud is an array containing the required audience', () => {
    const tok = sign({ sub: 'a', aud: ['other', 'sammy'] });
    expect(verifyJwtRS256(tok, issuer.publicKey, { audience: 'sammy' }).ok).toBe(true);
  });

  it('rejects a wrong audience', () => {
    const tok = sign({ sub: 'a', aud: 'someone-else' });
    const r = verifyJwtRS256(tok, issuer.publicKey, { audience: 'sammy' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/audience mismatch/);
  });

  it('rejects a missing audience when one is required', () => {
    const tok = sign({ sub: 'a' }); // no aud claim
    expect(verifyJwtRS256(tok, issuer.publicKey, { audience: 'sammy' }).ok).toBe(false);
  });

  it('rejects a wrong issuer', () => {
    const tok = sign({ sub: 'a', iss: 'https://evil' });
    const r = verifyJwtRS256(tok, issuer.publicKey, { issuer: 'https://idp' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/issuer mismatch/);
  });

  it('rejects a token issued in the future (iat)', () => {
    const future = Math.floor(Date.now() / 1000) + 10_000;
    const tok = sign({ sub: 'a', iat: future });
    const r = verifyJwtRS256(tok, issuer.publicKey);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/issued in the future/);
  });

  it('ignores aud/iss when not configured (back-compat default)', () => {
    const tok = sign({ sub: 'a', aud: 'whatever', iss: 'whoever' });
    expect(verifyJwtRS256(tok, issuer.publicKey).ok).toBe(true);
  });

  it('the JWKS path enforces audience too', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          keys: [{ ...(issuer.publicKey.export({ format: 'jwk' }) as object), kid: 'k', alg: 'RS256' }],
        }),
      } as Response;
    }) as unknown as typeof fetch;
    const client = createJwksClient({ jwksUri: 'https://issuer/jwks', fetchImpl });
    const good = signJwtRS256({ sub: 'a', aud: 'sammy' }, issuer.privateKey, { kid: 'k' });
    const bad = signJwtRS256({ sub: 'a', aud: 'nope' }, issuer.privateKey, { kid: 'k' });
    expect((await client.verify(good, { audience: 'sammy' })).ok).toBe(true);
    expect((await client.verify(bad, { audience: 'sammy' })).ok).toBe(false);
    // Both tokens carry the same `kid`, so the key set must be fetched ONCE
    // and cached — re-fetching per verify would make every request a
    // round-trip to the IdP and a liveness dependency on it.
    expect(calls).toBe(1);
  });
});
