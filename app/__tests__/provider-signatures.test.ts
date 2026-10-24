/**
 * Provider webhook signature verification.
 *
 * Every expected digest below was produced by OPENSSL, not by the code under
 * test:
 *
 *   printf '%s' 'Hello, World!' | openssl dgst -sha256 -hmac "$SECRET"
 *
 * That matters. A round-trip test (sign with our signer, verify with our
 * verifier) passes just as happily when the signed-payload construction is
 * wrong — it only proves the module agrees with itself, which is exactly the
 * bug you ship to production and discover when the provider's real requests
 * all 401. Pinning an independent implementation's output makes the
 * construction itself the thing under test.
 *
 * The GitHub case is stronger still: `GITHUB_VECTOR` is the example
 * published in GitHub's own "validating webhook deliveries" docs, and
 * openssl reproduces it byte-for-byte — so the secret/payload/digest triple
 * is confirmed from two independent directions.
 */

import {
  WEBHOOK_PROVIDERS,
  describeProviderScheme,
  isWebhookProvider,
  providerFromSigned,
  providerHeaders,
  providerIsTimestamped,
  standardWebhooksKey,
  verifyProviderSignature,
  type WebhookProvider,
} from '../src/server/provider-signatures';

const SECRET = "It's a Secret to Everybody";
const BODY = 'Hello, World!';
const TS = 1_700_000_000;
/** Freeze "now" on the signed timestamp so the tolerance window is stable. */
const NOW_MS = TS * 1000;

// ── openssl-derived vectors (see the file header) ──
/** GitHub's own published example. */
const GITHUB_VECTOR = '757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
const SHOPIFY_B64 = 'dXEH6g6yUJ/CESIczphLijdXC211hsIsRvQ3nIsEPhc=';
const STRIPE_HEX = '76c83fd0acdf22faed320674fe8e04d528cfe8a17905e720a9611e40677c03b7';
const SLACK_HEX = 'ea77f8f5e5fa3d18e87d85ad3d0671d4155ce53da0d046159b838274dc6943c9';
/** `whsec_` + base64("Hello, World!"), so the HMAC key is those 13 bytes. */
const SWH_SECRET = 'whsec_SGVsbG8sIFdvcmxkIQ==';
const SWH_ID = 'msg_2b3c';
const SWH_B64 = '4toJhnsdCuQuTegEwHkVX9z1izJNqe1qnKKDdXg636c=';

type Headers = Record<string, string | string[] | undefined>;

const verify = (
  provider: Exclude<WebhookProvider, 'sammy'>,
  headers: Headers,
  opts: { body?: string; secret?: string; nowMs?: number } = {},
) =>
  verifyProviderSignature(provider, {
    body: opts.body ?? BODY,
    headers,
    secret: opts.secret ?? SECRET,
    nowMs: opts.nowMs ?? NOW_MS,
  });

describe('each provider scheme matches an independent implementation', () => {
  test('github: X-Hub-Signature-256 over the raw body (published vector)', () => {
    expect(
      verify('github', { 'x-hub-signature-256': `sha256=${GITHUB_VECTOR}` }),
    ).toEqual({ ok: true, provider: 'github' });
  });

  test('linear: a bare hex HMAC of the raw body, no prefix', () => {
    expect(verify('linear', { 'linear-signature': GITHUB_VECTOR })).toEqual({
      ok: true,
      provider: 'linear',
    });
    // The prefix is GitHub's, not Linear's — sending it must not pass.
    expect(verify('linear', { 'linear-signature': `sha256=${GITHUB_VECTOR}` }).ok).toBe(
      false,
    );
  });

  test('shopify: the same HMAC, BASE64 rather than hex', () => {
    expect(verify('shopify', { 'x-shopify-hmac-sha256': SHOPIFY_B64 })).toEqual({
      ok: true,
      provider: 'shopify',
    });
    // Hex where base64 is expected is a decode that must not accidentally pass.
    expect(verify('shopify', { 'x-shopify-hmac-sha256': GITHUB_VECTOR }).ok).toBe(false);
  });

  test('stripe: t=<unix>,v1=<hex> over "<t>.<body>"', () => {
    expect(verify('stripe', { 'stripe-signature': `t=${TS},v1=${STRIPE_HEX}` })).toEqual({
      ok: true,
      provider: 'stripe',
    });
    // Binding the timestamp INTO the payload is the whole point: the raw-body
    // digest must not verify under Stripe's scheme.
    expect(
      verify('stripe', { 'stripe-signature': `t=${TS},v1=${GITHUB_VECTOR}` }).ok,
    ).toBe(false);
  });

  test('stripe: accepts any one of several v1s (secret rotation)', () => {
    const rotating = `t=${TS},v1=${'0'.repeat(64)},v1=${STRIPE_HEX}`;
    expect(verify('stripe', { 'stripe-signature': rotating }).ok).toBe(true);
  });

  test('slack: v0=<hex> over "v0:<timestamp>:<body>"', () => {
    expect(
      verify('slack', {
        'x-slack-signature': `v0=${SLACK_HEX}`,
        'x-slack-request-timestamp': String(TS),
      }),
    ).toEqual({ ok: true, provider: 'slack' });
  });

  test('slack: the timestamp header is part of the signature, not decoration', () => {
    expect(
      verify('slack', {
        'x-slack-signature': `v0=${SLACK_HEX}`,
        'x-slack-request-timestamp': String(TS + 1), // still inside tolerance
      }).ok,
    ).toBe(false);
  });

  test('standard-webhooks: v1,<base64> over "<id>.<timestamp>.<body>"', () => {
    expect(
      verify(
        'standard-webhooks',
        {
          'webhook-id': SWH_ID,
          'webhook-timestamp': String(TS),
          'webhook-signature': `v1,${SWH_B64}`,
        },
        { secret: SWH_SECRET },
      ),
    ).toEqual({ ok: true, provider: 'standard-webhooks' });
  });

  test('standard-webhooks: picks the matching entry from a rotation list', () => {
    expect(
      verify(
        'standard-webhooks',
        {
          'webhook-id': SWH_ID,
          'webhook-timestamp': String(TS),
          // Space-separated, and an unknown version must be skipped not fatal.
          'webhook-signature': `v0,Zm9v v1,${Buffer.alloc(32).toString('base64')} v1,${SWH_B64}`,
        },
        { secret: SWH_SECRET },
      ).ok,
    ).toBe(true);
  });

  test('gitlab: the shared token verbatim, and nothing else', () => {
    expect(verify('gitlab', { 'x-gitlab-token': SECRET })).toEqual({
      ok: true,
      provider: 'gitlab',
    });
    expect(verify('gitlab', { 'x-gitlab-token': `${SECRET} ` }).ok).toBe(true); // trimmed
    expect(verify('gitlab', { 'x-gitlab-token': 'wrong' }).ok).toBe(false);
  });
});

describe('the whsec_ secret is decoded, not used as a string', () => {
  // Using the printable secret as the HMAC key is the classic way a Standard
  // Webhooks integration silently fails to verify every request.
  test('a whsec_ secret keys the HMAC with its DECODED bytes', () => {
    expect(standardWebhooksKey(SWH_SECRET).toString('utf8')).toBe('Hello, World!');
  });

  test('a secret without the prefix is used as raw UTF-8', () => {
    expect(standardWebhooksKey('plain-secret').toString('utf8')).toBe('plain-secret');
  });

  test('a whsec_ prefix on non-base64 falls back to the literal bytes', () => {
    expect(standardWebhooksKey('whsec_not!base64!').toString('utf8')).toBe('not!base64!');
  });

  test('the undecoded string as a key does NOT verify', () => {
    expect(
      verify(
        'standard-webhooks',
        {
          'webhook-id': SWH_ID,
          'webhook-timestamp': String(TS),
          'webhook-signature': `v1,${SWH_B64}`,
        },
        // The same secret with the prefix stripped by hand → wrong key bytes.
        { secret: 'SGVsbG8sIFdvcmxkIQ==' },
      ).ok,
    ).toBe(false);
  });
});

describe('rejection paths — every provider, every direction', () => {
  const validHeaders: Record<Exclude<WebhookProvider, 'sammy'>, Headers> = {
    github: { 'x-hub-signature-256': `sha256=${GITHUB_VECTOR}` },
    linear: { 'linear-signature': GITHUB_VECTOR },
    shopify: { 'x-shopify-hmac-sha256': SHOPIFY_B64 },
    stripe: { 'stripe-signature': `t=${TS},v1=${STRIPE_HEX}` },
    slack: {
      'x-slack-signature': `v0=${SLACK_HEX}`,
      'x-slack-request-timestamp': String(TS),
    },
    'standard-webhooks': {
      'webhook-id': SWH_ID,
      'webhook-timestamp': String(TS),
      'webhook-signature': `v1,${SWH_B64}`,
    },
    gitlab: { 'x-gitlab-token': SECRET },
  };
  const secretFor = (p: string) => (p === 'standard-webhooks' ? SWH_SECRET : SECRET);
  const providers = Object.keys(validHeaders) as Array<Exclude<WebhookProvider, 'sammy'>>;

  test.each(providers)('%s: no headers at all → rejected', p => {
    expect(verify(p, {}, { secret: secretFor(p) }).ok).toBe(false);
  });

  test.each(providers)('%s: an empty secret → rejected, never accepted', p => {
    expect(verify(p, validHeaders[p], { secret: '' })).toEqual({
      ok: false,
      reason: 'no secret configured',
    });
  });

  test.each(providers)('%s: the wrong secret → rejected', p => {
    expect(verify(p, validHeaders[p], { secret: 'not-the-secret' }).ok).toBe(false);
  });

  // gitlab signs nothing, so a body change is undetectable BY DESIGN — that
  // asymmetry is the reason its doc comment warns against choosing it.
  const bodySigning = providers.filter(p => p !== 'gitlab');
  test.each(bodySigning)('%s: a tampered body → rejected', p => {
    expect(
      verify(p, validHeaders[p], { secret: secretFor(p), body: 'Hello, World?' }).ok,
    ).toBe(false);
  });

  test.each(providers)('%s: garbage in the header → rejected, not thrown', p => {
    const junk = Object.fromEntries(
      Object.keys(validHeaders[p]).map(h => [h, '!!!not-a-signature!!!']),
    );
    expect(() => verify(p, junk, { secret: secretFor(p) })).not.toThrow();
    expect(verify(p, junk, { secret: secretFor(p) }).ok).toBe(false);
  });

  test.each(providers)('%s: a repeated header (array value) uses the first', p => {
    const arrayed = Object.fromEntries(
      Object.entries(validHeaders[p]).map(([h, v]) => [h, [v as string, 'second']]),
    );
    expect(verify(p, arrayed, { secret: secretFor(p) }).ok).toBe(true);
  });
});

describe('timestamp tolerance bounds the replay window', () => {
  const timestamped: Array<[Exclude<WebhookProvider, 'sammy'>, Headers, string]> = [
    ['stripe', { 'stripe-signature': `t=${TS},v1=${STRIPE_HEX}` }, SECRET],
    [
      'slack',
      {
        'x-slack-signature': `v0=${SLACK_HEX}`,
        'x-slack-request-timestamp': String(TS),
      },
      SECRET,
    ],
    [
      'standard-webhooks',
      {
        'webhook-id': SWH_ID,
        'webhook-timestamp': String(TS),
        'webhook-signature': `v1,${SWH_B64}`,
      },
      SWH_SECRET,
    ],
  ];

  test.each(timestamped)(
    '%s: a signature captured an hour ago no longer verifies',
    (provider, headers, secret) => {
      // Same bytes, same valid signature — only the clock moved.
      expect(verify(provider, headers, { secret, nowMs: NOW_MS }).ok).toBe(true);
      expect(
        verify(provider, headers, { secret, nowMs: NOW_MS + 3_600_000 }),
      ).toEqual({ ok: false, reason: 'timestamp outside tolerance' });
    },
  );

  test.each(timestamped)('%s: a future timestamp is out of tolerance too', (p, h, s) => {
    expect(verify(p, h, { secret: s, nowMs: NOW_MS - 3_600_000 }).ok).toBe(false);
  });

  test('which providers bind a timestamp is reported honestly', () => {
    expect(providerIsTimestamped('stripe')).toBe(true);
    expect(providerIsTimestamped('slack')).toBe(true);
    expect(providerIsTimestamped('standard-webhooks')).toBe(true);
    expect(providerIsTimestamped('sammy')).toBe(true);
    // Signature-only: valid until the secret rotates. The provider's choice.
    expect(providerIsTimestamped('github')).toBe(false);
    expect(providerIsTimestamped('shopify')).toBe(false);
    expect(providerIsTimestamped('linear')).toBe(false);
    expect(providerIsTimestamped('gitlab')).toBe(false);
  });
});

describe('the `signed` trigger field maps to a provider', () => {
  test('true is the native scheme; false/absent requires nothing', () => {
    expect(providerFromSigned(true)).toBe('sammy');
    expect(providerFromSigned(false)).toBeNull();
    expect(providerFromSigned(undefined)).toBeNull();
  });

  test('a provider name selects that provider', () => {
    expect(providerFromSigned('github')).toBe('github');
    expect(providerFromSigned('standard-webhooks')).toBe('standard-webhooks');
  });

  test('an unknown name does NOT silently fall back to unsigned', () => {
    // Returning null here would turn a typo into an open endpoint; the schema
    // rejects it first, and lint covers the same ground.
    expect(isWebhookProvider('githbu')).toBe(false);
    expect(providerFromSigned('githbu')).toBeNull();
  });

  test('every provider can describe its own scheme and headers', () => {
    for (const p of WEBHOOK_PROVIDERS) {
      expect(providerHeaders(p).length).toBeGreaterThan(0);
      expect(describeProviderScheme(p)).toContain(providerHeaders(p)[0]);
    }
  });
});
