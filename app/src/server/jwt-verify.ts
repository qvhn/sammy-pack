/**
 * JWT verification (P-A2) — dependency-free, node:crypto only.
 *
 * Replaces the trusted `X-Sammy-User` header with a *verified* identity:
 * when a JWT verifier is configured, the API layer requires a signed Bearer
 * JWT and derives the owner from a claim (default `sub`), instead of believing
 * whatever the client put in the header.
 *
 * Two families, both built on node:crypto (no library):
 *   - **HS256** (`verifyJwtHS256`) — symmetric, shared secret. The common case
 *     for a single issuer (your own auth service minting tokens).
 *   - **RS256 + JWKS** (`verifyJwtRS256` / `createJwksClient`) — asymmetric,
 *     public-key verification with optional JWKS rotation. This is the OIDC
 *     federation path (Auth0 / Okta / Google / Azure AD / Cognito all expose a
 *     JWKS URI and rotate signing keys). JWK → KeyObject conversion and
 *     signature checks use only `node:crypto`; key fetch uses global `fetch`.
 *
 * The API's identity seam picks ONE verifier by env precedence
 * (`SAMMY_JWKS_URI` > `SAMMY_JWT_PUBLIC_KEY` > `SAMMY_JWT_SECRET`), so the
 * symmetric/asymmetric "alg confusion" downgrade can't happen — each verifier
 * pins its own algorithm family and key type.
 */

import {
  createHmac,
  createPublicKey,
  createSign,
  createVerify,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';

export type JwtResult =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; reason: string };

function b64urlToBuf(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function bufToB64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a compact JWT's protected header without verifying. Used to read
 *  `alg` / `kid` so the JWKS client can pick the right key. Null if malformed. */
export function decodeJwtHeader(
  token: string,
): { alg?: string; kid?: string; typ?: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(b64urlToBuf(parts[0]).toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Verification options shared by every verifier. `now` overrides the clock
 * (tests). `audience` / `issuer`, when set, are REQUIRED claims — the token's
 * `aud` must include `audience` and its `iss` must equal `issuer`. This is what
 * separates a forgery-safe single-key JWT check from one that's safe to trust
 * across issuers: without them, ANY token the configured key/JWKS signs is
 * accepted regardless of who it was minted for.
 */
export type VerifyOpts = {
  now?: number;
  audience?: string;
  issuer?: string;
  /** Tolerance (seconds) for clock skew on iat/nbf/exp. Default 60. */
  clockSkewSec?: number;
};

/** Shared exp/nbf check. Returns a reason string when invalid, else null. */
function checkTime(
  payload: Record<string, unknown>,
  nowMs: number,
  skewSec = 60,
): string | null {
  const now = Math.floor(nowMs / 1000);
  if (typeof payload.exp === 'number' && now - skewSec >= payload.exp) {
    return 'token expired';
  }
  if (typeof payload.nbf === 'number' && now + skewSec < payload.nbf) {
    return 'token not yet valid';
  }
  return null;
}

/**
 * Full claim validation: time (exp/nbf/iat) + audience + issuer. Returns a
 * reason string when invalid, else null. `aud` may be a string or an array of
 * strings (per RFC 7519); the configured `audience` must be among them.
 */
function checkClaims(
  payload: Record<string, unknown>,
  opts?: VerifyOpts,
): string | null {
  const nowMs = opts?.now ?? Date.now();
  const skew = opts?.clockSkewSec ?? 60;
  const timeReason = checkTime(payload, nowMs, skew);
  if (timeReason) return timeReason;

  const now = Math.floor(nowMs / 1000);
  if (typeof payload.iat === 'number' && payload.iat > now + skew) {
    return 'token issued in the future';
  }
  if (opts?.issuer !== undefined && payload.iss !== opts.issuer) {
    return `issuer mismatch (expected "${opts.issuer}")`;
  }
  if (opts?.audience !== undefined) {
    const aud = payload.aud;
    const audiences = Array.isArray(aud)
      ? aud
      : typeof aud === 'string'
        ? [aud]
        : [];
    if (!audiences.includes(opts.audience)) {
      return `audience mismatch (expected "${opts.audience}")`;
    }
  }
  return null;
}

/** Verify a compact HS256 JWT against `secret`. Checks structure, alg,
 *  signature (constant-time), and `exp` / `nbf` if present. Never throws. */
export function verifyJwtHS256(
  token: string,
  secret: string,
  opts?: VerifyOpts,
): JwtResult {
  if (!token || !secret) return { ok: false, reason: 'missing token or secret' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  const [h, p, sig] = parts;

  let header: { alg?: string };
  try {
    header = JSON.parse(b64urlToBuf(h).toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad header' };
  }
  if (header.alg !== 'HS256') {
    return { ok: false, reason: `unsupported alg "${header.alg}" (HS256 only)` };
  }

  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  let provided: Buffer;
  try {
    provided = b64urlToBuf(sig);
  } catch {
    return { ok: false, reason: 'bad signature encoding' };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'signature mismatch' };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64urlToBuf(p).toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad payload' };
  }
  const claimReason = checkClaims(payload, opts);
  if (claimReason) return { ok: false, reason: claimReason };
  return { ok: true, claims: payload };
}

/** Mint an HS256 JWT — for tests + docs (and a future "issue a dev token"
 *  affordance). Not used on the request path. */
export function signJwtHS256(
  claims: Record<string, unknown>,
  secret: string,
): string {
  const enc = (o: unknown) =>
    bufToB64url(Buffer.from(JSON.stringify(o), 'utf8'));
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc(claims);
  const sig = bufToB64url(
    createHmac('sha256', secret).update(`${head}.${body}`).digest(),
  );
  return `${head}.${body}.${sig}`;
}

// ─── RS256 (asymmetric) + JWKS ─────────────────────────────────────────────

/** A public key for RS256 verification: a node `KeyObject`, a PEM/SPKI string,
 *  or a raw JWK object (`{ kty: 'RSA', n, e, ... }`). */
export type RsaPublicKey = KeyObject | string | Record<string, unknown>;

/** Coerce a supported public-key form into a node KeyObject. Throws on bad
 *  input (callers wrap so verification never throws). */
function toPublicKey(key: RsaPublicKey): KeyObject {
  if (typeof key === 'object' && key !== null && 'asymmetricKeyType' in key) {
    return key as KeyObject;
  }
  if (typeof key === 'string') return createPublicKey(key);
  // JWK
  return createPublicKey({ key: key as object, format: 'jwk' });
}

/**
 * Verify a compact RS256 JWT against an RSA public key. Pins `alg` to RS256
 * (an asymmetric verifier must never accept an HS* token — that's the classic
 * downgrade), checks the signature with `node:crypto`, and validates
 * `exp` / `nbf`. Never throws.
 */
export function verifyJwtRS256(
  token: string,
  key: RsaPublicKey,
  opts?: VerifyOpts,
): JwtResult {
  if (!token) return { ok: false, reason: 'missing token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  const [h, p, sig] = parts;

  let header: { alg?: string };
  try {
    header = JSON.parse(b64urlToBuf(h).toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad header' };
  }
  if (header.alg !== 'RS256') {
    return { ok: false, reason: `unsupported alg "${header.alg}" (RS256 only)` };
  }

  let keyObj: KeyObject;
  try {
    keyObj = toPublicKey(key);
  } catch (err) {
    return { ok: false, reason: `bad public key: ${(err as Error).message}` };
  }
  if (keyObj.asymmetricKeyType !== 'rsa') {
    return {
      ok: false,
      reason: `public key is "${keyObj.asymmetricKeyType}", expected rsa`,
    };
  }

  let valid: boolean;
  try {
    const provided = b64urlToBuf(sig);
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${p}`);
    v.end();
    valid = v.verify(keyObj, provided);
  } catch {
    return { ok: false, reason: 'signature verification error' };
  }
  if (!valid) return { ok: false, reason: 'signature mismatch' };

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64urlToBuf(p).toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad payload' };
  }
  const claimReason = checkClaims(payload, opts);
  if (claimReason) return { ok: false, reason: claimReason };
  return { ok: true, claims: payload };
}

type Jwk = { kid?: string; kty?: string; use?: string; [k: string]: unknown };

export type JwksClient = {
  /** Verify a token by selecting the signing key from the JWKS by its `kid`
   *  (or the sole key when the token omits `kid`). Fetches + caches keys;
   *  an unknown `kid` triggers a refetch (handles rotation), throttled by
   *  `minRefetchMs`. Never throws — failures surface as `{ ok: false }`. */
  verify(token: string, opts?: VerifyOpts): Promise<JwtResult>;
};

/**
 * A JWKS-backed RS256 verifier. Resolves the issuer's signing keys from a
 * JWKS URI (e.g. `https://issuer/.well-known/jwks.json`), caches them by
 * `kid`, and refetches when a token presents an unseen `kid` (key rotation) —
 * with a `minRefetchMs` floor so a flood of bogus `kid`s can't hammer the
 * endpoint. `fetchImpl` is injectable for tests.
 */
export function createJwksClient(config: {
  jwksUri: string;
  fetchImpl?: typeof fetch;
  /** Don't refetch the JWKS more often than this on unknown-kid misses. */
  minRefetchMs?: number;
  now?: () => number;
}): JwksClient {
  const doFetch = config.fetchImpl ?? fetch;
  const minRefetchMs = config.minRefetchMs ?? 10_000;
  const now = config.now ?? Date.now;

  const cache = new Map<string, KeyObject>();
  let lastFetchAt = 0;
  let inflight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    if (inflight) return inflight;
    inflight = (async () => {
      const res = await doFetch(config.jwksUri);
      if (!res.ok) {
        throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { keys?: Jwk[] };
      const keys = Array.isArray(body?.keys) ? body.keys : [];
      const next = new Map<string, KeyObject>();
      for (const jwk of keys) {
        if (jwk.kty !== 'RSA') continue; // only RSA signing keys
        try {
          next.set(jwk.kid ?? '', toPublicKey(jwk));
        } catch {
          /* skip an unparseable key rather than fail the whole set */
        }
      }
      cache.clear();
      for (const [k, v] of next) cache.set(k, v);
      lastFetchAt = now();
    })();
    try {
      await inflight;
    } finally {
      inflight = null;
    }
  }

  async function getKey(kid: string | undefined): Promise<KeyObject> {
    const lookup = kid ?? '';
    if (cache.has(lookup)) return cache.get(lookup)!;
    // No-kid token with a single cached key — use it.
    if (!kid && cache.size === 1) return [...cache.values()][0];
    if (now() - lastFetchAt < minRefetchMs && lastFetchAt !== 0) {
      throw new Error(
        kid ? `no signing key for kid "${kid}"` : 'no signing key in JWKS',
      );
    }
    await refresh();
    if (cache.has(lookup)) return cache.get(lookup)!;
    if (!kid && cache.size === 1) return [...cache.values()][0];
    throw new Error(
      kid ? `no signing key for kid "${kid}"` : 'no signing key in JWKS',
    );
  }

  return {
    async verify(token, opts) {
      const header = decodeJwtHeader(token);
      if (!header) return { ok: false, reason: 'malformed token' };
      if (header.alg !== 'RS256') {
        return {
          ok: false,
          reason: `unsupported alg "${header.alg}" (RS256 only)`,
        };
      }
      let key: KeyObject;
      try {
        key = await getKey(header.kid);
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
      return verifyJwtRS256(token, key, opts);
    },
  };
}

/** Mint an RS256 JWT — for tests + docs only (not used on the request path).
 *  `privateKey` is a node KeyObject or a PEM private-key string. */
export function signJwtRS256(
  claims: Record<string, unknown>,
  privateKey: KeyObject | string,
  opts?: { kid?: string },
): string {
  const enc = (o: unknown) =>
    bufToB64url(Buffer.from(JSON.stringify(o), 'utf8'));
  const header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' };
  if (opts?.kid) header.kid = opts.kid;
  const head = enc(header);
  const body = enc(claims);
  const s = createSign('RSA-SHA256');
  s.update(`${head}.${body}`);
  s.end();
  const sig = bufToB64url(s.sign(privateKey));
  return `${head}.${body}.${sig}`;
}
