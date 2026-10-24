/**
 * Provider webhook signature verification.
 *
 * WHY: `webhook-auth.ts` verifies sammy-pack's OWN scheme, read from
 * `X-Sammy-Signature`. That works for callers you control — the queue-source
 * adapters, your own services — but no third-party provider will ever send
 * that header. GitHub signs `X-Hub-Signature-256`, Stripe signs
 * `Stripe-Signature`, Slack `X-Slack-Signature`, and so on, each over a
 * different signed-payload construction. So a `"signed": true` trigger could
 * not actually receive a signed GitHub webhook: the only options were to
 * leave the endpoint unauthenticated or to put a translating proxy in front
 * of it. This module closes that gap.
 *
 * Declare the provider on the trigger (`"signed": "github"`), and the
 * ingress verifies that provider's scheme against `SAMMY_WEBHOOK_SECRET`.
 * `"signed": true` keeps meaning sammy-pack's native scheme.
 *
 * All schemes HMAC the RAW REQUEST BODY — the exact bytes received, before
 * any JSON parse/re-serialize. Re-serializing changes key order and
 * whitespace and breaks every signature here.
 *
 * REPLAY: the timestamped providers (stripe, slack, standard-webhooks) get a
 * tolerance window, which bounds how long a captured request stays valid.
 * They deliberately do NOT use the nonce cache that sammy's own v2 scheme
 * does, because providers RETRY failed deliveries — GitHub and Svix resend
 * with the same id, and rejecting that as a replay would silently drop real
 * events. Duplicate suppression belongs to the delivery layer's
 * idempotency key, not to signature verification.
 *
 * Each scheme below is implemented from its provider's published spec. The
 * GitHub case is additionally pinned to the published example vector in
 * `provider-signatures.test.ts`, which is what proves the construction is
 * right and not merely self-consistent.
 */

import { timingSafeEqual } from 'node:crypto';
import { SIGNATURE_TOLERANCE_SECONDS, hmacPrefixed } from './webhook-auth';
import { WEBHOOK_PROVIDER_NAMES } from '../types';

/** Providers whose signature scheme the ingress can verify. `sammy` is the
 *  native `X-Sammy-Signature` scheme (see webhook-auth.ts); the rest come
 *  from `types.ts`, which is pure — so the trigger-kind registry can
 *  VALIDATE a declared provider name without importing any crypto, and the
 *  accepted set can never drift between the validator and this verifier. */
export const WEBHOOK_PROVIDERS = ['sammy', ...WEBHOOK_PROVIDER_NAMES] as const;

export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

export function isWebhookProvider(v: unknown): v is WebhookProvider {
  return typeof v === 'string' && (WEBHOOK_PROVIDERS as readonly string[]).includes(v);
}

/** Normalize a trigger's `signed` value to the provider to enforce.
 *  `true` → the native scheme; `false`/absent → no signature required. */
export function providerFromSigned(signed: unknown): WebhookProvider | null {
  if (signed === true) return 'sammy';
  if (isWebhookProvider(signed)) return signed;
  return null;
}

export type ProviderVerdict =
  | { ok: true; provider: WebhookProvider }
  | { ok: false; reason: string };

export interface ProviderVerifyInput {
  /** The raw request body, exactly as received. Pass the Buffer wherever you
   *  have it: every scheme here HMACs the raw bytes, and a body decoded to a
   *  string first is lossy for anything that is not valid UTF-8, which makes
   *  a genuine delivery fail to verify. See `bodyBytes` in webhook-auth. */
  body: string | Buffer;
  /** Request headers (node lowercases incoming names). */
  headers: Record<string, string | string[] | undefined>;
  secret: string;
  nowMs?: number;
  toleranceSeconds?: number;
}

// ─── primitives ─────────────────────────────────────────────────────────────

function header(
  headers: ProviderVerifyInput['headers'],
  name: string,
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() || undefined;
}

/** Constant-time compare of two buffers; false on a length mismatch. */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function safeHexEqual(hex: string, expected: Buffer): boolean {
  if (hex.length % 2 !== 0 || !/^[a-f0-9]+$/i.test(hex)) return false;
  return safeEqual(Buffer.from(hex, 'hex'), expected);
}

function safeBase64Equal(b64: string, expected: Buffer): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return false;
  let provided: Buffer;
  try {
    provided = Buffer.from(b64, 'base64');
  } catch {
    return false;
  }
  return safeEqual(provided, expected);
}

/** HMAC over an ASCII prefix + the RAW body bytes. A scheme with no prefix
 *  passes ''. Never build the signed payload as a template string: a Buffer
 *  body would be coerced via String(buf) rather than hashed. */
const hmac = (
  key: Buffer | string,
  prefix: string,
  body: string | Buffer,
): Buffer => hmacPrefixed(key, prefix, body);

/** Enforce a signed timestamp's freshness. Bounds the window in which a
 *  captured request can be replayed. */
function checkTimestamp(
  tsSeconds: string,
  input: ProviderVerifyInput,
): ProviderVerdict | null {
  if (!/^\d+$/.test(tsSeconds)) return { ok: false, reason: 'malformed timestamp' };
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(nowSec - Number(tsSeconds)) > tolerance) {
    return { ok: false, reason: 'timestamp outside tolerance' };
  }
  return null;
}

// ─── schemes ────────────────────────────────────────────────────────────────

interface Scheme {
  /** Header(s) the caller must send — used in the 401 message and the docs. */
  readonly headers: readonly string[];
  /** One line describing the construction, for the rejection message. */
  readonly describe: string;
  /** True when this scheme binds a timestamp (bounded replay window). */
  readonly timestamped: boolean;
  verify(input: ProviderVerifyInput): ProviderVerdict;
}

const ok = (provider: WebhookProvider): ProviderVerdict => ({ ok: true, provider });
const mismatch: ProviderVerdict = { ok: false, reason: 'signature mismatch' };
const missing = (h: string): ProviderVerdict => ({
  ok: false,
  reason: `missing ${h}`,
});

/** GitHub — and the same construction used by Bitbucket, Jira, Gitea and
 *  most "X-Hub-Signature-256" implementations descended from GitHub's. */
const github: Scheme = {
  headers: ['X-Hub-Signature-256'],
  describe: 'X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>',
  timestamped: false,
  verify(input) {
    const h = header(input.headers, 'x-hub-signature-256');
    if (!h) return missing('X-Hub-Signature-256');
    const m = /^sha256=([a-f0-9]+)$/i.exec(h);
    if (!m) return { ok: false, reason: 'malformed header' };
    return safeHexEqual(m[1], hmac(input.secret, '', input.body))
      ? ok('github')
      : mismatch;
  },
};

/** Stripe — `t=<unix>,v1=<hex>` over `<t>.<body>`. More than one `v1` may be
 *  present while a signing secret is being rotated; any match passes. */
const stripe: Scheme = {
  headers: ['Stripe-Signature'],
  describe:
    'Stripe-Signature: t=<unix-seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">',
  timestamped: true,
  verify(input) {
    const h = header(input.headers, 'stripe-signature');
    if (!h) return missing('Stripe-Signature');
    let t: string | undefined;
    const v1s: string[] = [];
    for (const seg of h.split(',')) {
      const eq = seg.indexOf('=');
      if (eq <= 0) return { ok: false, reason: 'malformed header' };
      const k = seg.slice(0, eq).trim();
      const v = seg.slice(eq + 1).trim();
      if (k === 't') t = v;
      else if (k === 'v1') v1s.push(v);
    }
    if (!t || v1s.length === 0) return { ok: false, reason: 'malformed header' };
    const stale = checkTimestamp(t, input);
    if (stale) return stale;
    const expected = hmac(input.secret, `${t}.`, input.body);
    return v1s.some(v => safeHexEqual(v, expected)) ? ok('stripe') : mismatch;
  },
};

/** Slack — `v0=<hex>` over `v0:<timestamp>:<body>`, timestamp in its own
 *  header. Covers Slack events, slash commands and interactivity. */
const slack: Scheme = {
  headers: ['X-Slack-Signature', 'X-Slack-Request-Timestamp'],
  describe:
    'X-Slack-Signature: v0=<hex HMAC-SHA256 of "v0:<X-Slack-Request-Timestamp>:<raw body>">',
  timestamped: true,
  verify(input) {
    const sig = header(input.headers, 'x-slack-signature');
    if (!sig) return missing('X-Slack-Signature');
    const ts = header(input.headers, 'x-slack-request-timestamp');
    if (!ts) return missing('X-Slack-Request-Timestamp');
    const m = /^v0=([a-f0-9]+)$/i.exec(sig);
    if (!m) return { ok: false, reason: 'malformed header' };
    const stale = checkTimestamp(ts, input);
    if (stale) return stale;
    const expected = hmac(input.secret, `v0:${ts}:`, input.body);
    return safeHexEqual(m[1], expected) ? ok('slack') : mismatch;
  },
};

/** Shopify — raw-body HMAC, BASE64 rather than hex. */
const shopify: Scheme = {
  headers: ['X-Shopify-Hmac-Sha256'],
  describe: 'X-Shopify-Hmac-Sha256: <base64 HMAC-SHA256 of the raw body>',
  timestamped: false,
  verify(input) {
    const h = header(input.headers, 'x-shopify-hmac-sha256');
    if (!h) return missing('X-Shopify-Hmac-Sha256');
    return safeBase64Equal(h, hmac(input.secret, '', input.body))
      ? ok('shopify')
      : mismatch;
  },
};

/** Linear — bare hex HMAC of the raw body, no prefix. */
const linear: Scheme = {
  headers: ['Linear-Signature'],
  describe: 'Linear-Signature: <hex HMAC-SHA256 of the raw body>',
  timestamped: false,
  verify(input) {
    const h = header(input.headers, 'linear-signature');
    if (!h) return missing('Linear-Signature');
    return safeHexEqual(h, hmac(input.secret, '', input.body))
      ? ok('linear')
      : mismatch;
  },
};

/** GitLab — NOT an HMAC. GitLab sends the shared secret itself in a header,
 *  so this verifies far less than the others: it proves the caller knows the
 *  token, but nothing about the body, and the token is replayable by anyone
 *  who captures one request. Supported because it is the only option GitLab
 *  offers; prefer any HMAC provider where you have the choice. */
const gitlab: Scheme = {
  headers: ['X-Gitlab-Token'],
  describe: 'X-Gitlab-Token: <the shared secret token verbatim>',
  timestamped: false,
  verify(input) {
    const h = header(input.headers, 'x-gitlab-token');
    if (!h) return missing('X-Gitlab-Token');
    return safeEqual(Buffer.from(h, 'utf8'), Buffer.from(input.secret, 'utf8'))
      ? ok('gitlab')
      : mismatch;
  },
};

/** The Standard Webhooks spec (standardwebhooks.com) — Svix and everything
 *  built on it: Resend, Clerk, Brex, Lob and others.
 *
 *  `webhook-signature` carries a SPACE-SEPARATED list of `v1,<base64>`
 *  (several during key rotation); the signed payload is
 *  `<webhook-id>.<webhook-timestamp>.<body>`. The secret is conventionally
 *  `whsec_<base64>`, and the HMAC key is those DECODED bytes — using the
 *  printable string as the key is the classic way this silently fails to
 *  verify. A secret without the prefix is used as raw UTF-8. */
const standardWebhooks: Scheme = {
  headers: ['webhook-id', 'webhook-timestamp', 'webhook-signature'],
  describe:
    'webhook-signature: v1,<base64 HMAC-SHA256 of "<webhook-id>.<webhook-timestamp>.<raw body>">',
  timestamped: true,
  verify(input) {
    const id = header(input.headers, 'webhook-id');
    if (!id) return missing('webhook-id');
    const ts = header(input.headers, 'webhook-timestamp');
    if (!ts) return missing('webhook-timestamp');
    const sigHeader = header(input.headers, 'webhook-signature');
    if (!sigHeader) return missing('webhook-signature');
    const stale = checkTimestamp(ts, input);
    if (stale) return stale;

    const expected = hmac(standardWebhooksKey(input.secret), `${id}.${ts}.`, input.body);
    for (const entry of sigHeader.split(/\s+/)) {
      const comma = entry.indexOf(',');
      if (comma <= 0) continue;
      if (entry.slice(0, comma) !== 'v1') continue; // unknown version
      if (safeBase64Equal(entry.slice(comma + 1), expected)) return ok('standard-webhooks');
    }
    return mismatch;
  },
};

/** The HMAC key for a Standard Webhooks secret: the base64-decoded bytes
 *  after a `whsec_` prefix, else the string's own UTF-8 bytes. */
export function standardWebhooksKey(secret: string): Buffer {
  if (!secret.startsWith('whsec_')) return Buffer.from(secret, 'utf8');
  const b64 = secret.slice('whsec_'.length);
  const decoded = Buffer.from(b64, 'base64');
  // Buffer.from ignores invalid base64 rather than throwing; if it round-trips
  // we had real base64, otherwise fall back to the literal bytes.
  return decoded.toString('base64').replace(/=+$/, '') === b64.replace(/=+$/, '')
    ? decoded
    : Buffer.from(b64, 'utf8');
}

const SCHEMES: Record<Exclude<WebhookProvider, 'sammy'>, Scheme> = {
  github,
  stripe,
  slack,
  shopify,
  linear,
  gitlab,
  'standard-webhooks': standardWebhooks,
};

// ─── entry points ───────────────────────────────────────────────────────────

/** Verify a third-party provider's signature. `sammy` is NOT handled here —
 *  the caller routes that to `verifySignature` in webhook-auth.ts, which owns
 *  the native scheme (including its nonce cache). */
export function verifyProviderSignature(
  provider: Exclude<WebhookProvider, 'sammy'>,
  input: ProviderVerifyInput,
): ProviderVerdict {
  if (!input.secret) return { ok: false, reason: 'no secret configured' };
  const scheme = SCHEMES[provider];
  if (!scheme) return { ok: false, reason: `unknown provider "${provider}"` };
  try {
    return scheme.verify(input);
  } catch (err) {
    // Verification must never 500 on a malformed header.
    return { ok: false, reason: `verification error: ${(err as Error)?.message ?? err}` };
  }
}

/** The headers a provider must send — for the 401 body and `/api/triggers`. */
export function providerHeaders(provider: WebhookProvider): readonly string[] {
  return provider === 'sammy' ? ['X-Sammy-Signature'] : SCHEMES[provider].headers;
}

/** One-line description of a provider's construction, for rejection messages. */
export function describeProviderScheme(provider: WebhookProvider): string {
  return provider === 'sammy'
    ? 'X-Sammy-Signature: t=<unix-seconds>,n=<nonce>,v1=<hex HMAC-SHA256 of "t.n.body"> ' +
        '(or legacy sha256=<hex HMAC-SHA256 of body>)'
    : SCHEMES[provider].describe;
}

/** True when the provider's scheme binds a timestamp, so a captured request
 *  expires. False means signature-only: valid forever until the secret is
 *  rotated (the provider's design choice, not sammy's). */
export function providerIsTimestamped(provider: WebhookProvider): boolean {
  return provider === 'sammy' ? true : SCHEMES[provider].timestamped;
}
