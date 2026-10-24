/**
 * Client-side request signing — the canonical HMAC scheme producers use to
 * authenticate against a `"signed": true` sammy-pack trigger.
 *
 * This is the SIGNING half of the trigger-ingress auth scheme. The
 * VERIFYING half (timestamp tolerance, nonce-replay rejection, the
 * `NonceCache`) is server-only and lives in the engine's `webhook-auth.ts`;
 * it imports these two functions so the scheme is defined in exactly ONE
 * place and can never drift between signer and verifier.
 *
 * Both formats match what the verifier accepts:
 *
 *   legacy (no replay protection):
 *     `sha256=<hex>`  where <hex> = HMAC-SHA256(rawBody, secret).
 *
 *   v2 (preferred — replay-protected):
 *     `t=<unix-seconds>[,n=<nonce>],v1=<hex>`
 *     where <hex> = HMAC-SHA256(`${t}.${nonce}.${rawBody}`, secret).
 *     When no nonce is supplied the signed payload is `${t}..${rawBody}`
 *     (empty nonce slot — the two dots stay), matching the verifier.
 *
 * Pure `node:crypto`; no other dependency. This is the only crypto the SDK
 * carries, which is what keeps adapter packages that depend on the SDK
 * dependency-light.
 */

import { createHmac } from 'node:crypto';

/** Compute the legacy `X-Sammy-Signature: sha256=<hex>` header value for
 *  `body` + `secret`. HMAC-SHA256 over the raw body. */
export function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

/** Compute a v2 (replay-protected) `X-Sammy-Signature` header value.
 *  `timestampMs` defaults to now; pass a `nonce` (any unique string — a
 *  UUID is fine) to also get within-window replay rejection on the
 *  verifier. The signed payload is `${t}.${nonce}.${body}`. */
export function signWebhookBodyV2(
  body: string,
  secret: string,
  opts: { timestampMs?: number; nonce?: string } = {},
): string {
  const t = Math.floor((opts.timestampMs ?? Date.now()) / 1000);
  const n = opts.nonce ?? '';
  const hex = createHmac('sha256', secret)
    .update(`${t}.${n}.${body}`, 'utf8')
    .digest('hex');
  return n ? `t=${t},n=${n},v1=${hex}` : `t=${t},v1=${hex}`;
}
