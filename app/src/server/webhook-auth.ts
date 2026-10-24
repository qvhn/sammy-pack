/**
 * Trigger-ingress signature verification (P4).
 *
 * Signed triggers (webhook / events / deployment / queue) authenticate with
 * an HMAC instead of the admin bearer token, so external callers can be
 * authorized without holding SAMMY_API_TOKEN. The secret lives only in the
 * server env (SAMMY_WEBHOOK_SECRET) — never in committed orchestration JSON.
 *
 * Two `X-Sammy-Signature` formats are accepted:
 *
 *   v2 (preferred — replay-protected):
 *     t=<unix-seconds>,n=<nonce>,v1=<hex>
 *     where <hex> = HMAC-SHA256(`${t}.${nonce}.${rawBody}`, secret).
 *     `n` is optional; when omitted the signed payload is `${t}..${rawBody}`
 *     (empty nonce slot — the two dots stay). The timestamp must be within
 *     the tolerance window (default 300s, either direction), and a nonce is
 *     rejected on reuse within the cache TTL. Timestamp bounds how long a
 *     captured request stays valid; the nonce closes replay *inside* that
 *     window.
 *
 *   legacy (no replay protection):
 *     sha256=<hex>  where <hex> = HMAC-SHA256(rawBody, secret).
 *     Still accepted so existing callers keep working; new integrations
 *     should send v2.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** The exact bytes to HMAC.
 *
 *  A Buffer is used AS IS, which is the whole point. Every webhook scheme
 *  signs the raw bytes of the request, and decoding those to a JS string
 *  first is LOSSY: any byte sequence that is not valid UTF-8 becomes U+FFFD,
 *  and re-encoding that yields `ef bf bd` instead of the original byte. The
 *  digest then differs from the sender's and a genuinely-signed delivery is
 *  rejected 401 with nothing to diagnose. A string is encoded UTF-8, which
 *  is correct for callers that genuinely have text (our own signers). */
export function bodyBytes(body: string | Buffer): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
}

/** HMAC-SHA256 over an ASCII `prefix` followed by the raw body bytes.
 *  Concatenating buffers rather than building a template string is what
 *  keeps a Buffer body from being coerced via `String(buf)`. */
export function hmacPrefixed(
  secret: string | Buffer,
  prefix: string,
  body: string | Buffer,
): Buffer {
  return createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(prefix, 'utf8'), bodyBytes(body)]))
    .digest();
}

// The client-side SIGNERS (signWebhookBody / signWebhookBodyV2) live in
// `@sammy-pack/sdk` so producers + adapters can sign without depending on
// the engine. They are re-exported here so every existing engine call site
// + the webhook-auth test keep importing them from this module — the scheme
// is defined in exactly ONE place (the SDK) and can't drift between the
// signer and the verifier below.
export { signWebhookBody, signWebhookBodyV2 } from '@sammy-pack/sdk';

/** Default ± window a v2 timestamp may drift from server time. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Constant-time compare of a hex signature against an expected digest.
 *  Returns false on malformed hex or length mismatch — never throws. */
function safeHexEqual(hex: string, expected: Buffer): boolean {
  if (hex.length % 2 !== 0 || !/^[a-f0-9]+$/i.test(hex)) return false;
  let provided: Buffer;
  try {
    provided = Buffer.from(hex, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** Constant-time check of a legacy `X-Sammy-Signature: sha256=<hex>` header
 *  against HMAC-SHA256(body, secret). Pass the raw request Buffer where you
 *  have it (see `bodyBytes`). Returns false on any malformed or missing
 *  header, length mismatch, or value mismatch — never throws. */
export function verifyHmacSignature(
  body: string | Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header || !secret) return false;
  const m = /^sha256=([a-f0-9]+)$/i.exec(header.trim());
  if (!m) return false;
  const expected = hmacPrefixed(secret, '', body);
  return safeHexEqual(m[1], expected);
}

/** In-memory seen-nonce cache with TTL. One instance per server process —
 *  nonces only need to be remembered for the signature tolerance window, so
 *  the TTL defaults to 2× the tolerance. Sweeps lazily on insert. */
export class NonceCache {
  private seen = new Map<string, number>(); // nonce → expiresAtMs
  constructor(private ttlMs: number = SIGNATURE_TOLERANCE_SECONDS * 2 * 1000) {}

  /** True if `nonce` is fresh (and records it); false if already seen and
   *  unexpired. Call ONLY after the signature itself verified — unauthenticated
   *  garbage must not be able to poison the cache. */
  checkAndRecord(nonce: string, nowMs: number = Date.now()): boolean {
    this.sweep(nowMs);
    const expires = this.seen.get(nonce);
    if (expires !== undefined && expires > nowMs) return false;
    this.seen.set(nonce, nowMs + this.ttlMs);
    return true;
  }

  private sweep(nowMs: number): void {
    if (this.seen.size < 1024) return;
    for (const [n, exp] of this.seen) {
      if (exp <= nowMs) this.seen.delete(n);
    }
  }
}

export type SignatureVerdict =
  | { ok: true; scheme: 'v2' | 'legacy' }
  | { ok: false; reason: string };

/** Verify an `X-Sammy-Signature` header in either format. v2 gets timestamp
 *  tolerance + (when a nonce is present and a cache is supplied) replay
 *  rejection; legacy is signature-only. Never throws. */
export function verifySignature(
  body: string | Buffer,
  header: string | undefined,
  secret: string,
  opts: {
    nowMs?: number;
    toleranceSeconds?: number;
    nonces?: NonceCache;
  } = {},
): SignatureVerdict {
  if (!secret) return { ok: false, reason: 'no secret configured' };
  if (!header?.trim()) return { ok: false, reason: 'missing header' };
  const h = header.trim();

  if (/^sha256=/i.test(h)) {
    return verifyHmacSignature(body, h, secret)
      ? { ok: true, scheme: 'legacy' }
      : { ok: false, reason: 'signature mismatch' };
  }

  // v2: comma-separated k=v elements; `t` and `v1` required, `n` optional.
  const parts = new Map<string, string>();
  for (const seg of h.split(',')) {
    const eq = seg.indexOf('=');
    if (eq <= 0) return { ok: false, reason: 'malformed header' };
    parts.set(seg.slice(0, eq).trim(), seg.slice(eq + 1).trim());
  }
  const t = parts.get('t');
  const v1 = parts.get('v1');
  const nonce = parts.get('n') ?? '';
  if (!t || !v1) return { ok: false, reason: 'malformed header' };
  if (!/^\d+$/.test(t)) return { ok: false, reason: 'malformed timestamp' };

  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const tolerance = opts.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(nowSec - Number(t)) > tolerance) {
    return { ok: false, reason: 'timestamp outside tolerance' };
  }

  // `${t}.${nonce}.` then the RAW body bytes — interpolating a Buffer into
  // the template would stringify it instead of hashing it.
  const expected = hmacPrefixed(secret, `${t}.${nonce}.`, body);
  if (!safeHexEqual(v1, expected)) {
    return { ok: false, reason: 'signature mismatch' };
  }

  // Replay check LAST — only verified requests may record a nonce.
  if (nonce && opts.nonces) {
    if (!opts.nonces.checkAndRecord(nonce, opts.nowMs ?? Date.now())) {
      return { ok: false, reason: 'nonce replay' };
    }
  }
  return { ok: true, scheme: 'v2' };
}
