import {
  NonceCache,
  SIGNATURE_TOLERANCE_SECONDS,
  signWebhookBody,
  signWebhookBodyV2,
  verifyHmacSignature,
  verifySignature,
} from '../src/server/webhook-auth';

const SECRET = 'topsecret';
const BODY = '{"event":"pr.opened","number":42}';

describe('verifyHmacSignature (P4 signed webhooks)', () => {
  it('accepts a correctly-signed body', () => {
    const sig = signWebhookBody(BODY, SECRET);
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(verifyHmacSignature(BODY, sig, SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = signWebhookBody(BODY, SECRET);
    expect(verifyHmacSignature(BODY + ' ', sig, SECRET)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const sig = signWebhookBody(BODY, SECRET);
    expect(verifyHmacSignature(BODY, sig, 'other')).toBe(false);
  });

  it('rejects a missing / malformed / empty header', () => {
    expect(verifyHmacSignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifyHmacSignature(BODY, '', SECRET)).toBe(false);
    expect(verifyHmacSignature(BODY, 'deadbeef', SECRET)).toBe(false); // no sha256=
    expect(verifyHmacSignature(BODY, 'sha256=zzzz', SECRET)).toBe(false); // non-hex
    expect(verifyHmacSignature(BODY, 'sha256=abc', SECRET)).toBe(false); // odd length
  });

  it('rejects when no secret is configured', () => {
    const sig = signWebhookBody(BODY, SECRET);
    expect(verifyHmacSignature(BODY, sig, '')).toBe(false);
  });

  it('is case-insensitive on the hex digest', () => {
    const sig = signWebhookBody(BODY, SECRET).toUpperCase(); // SHA256=ABC...
    expect(verifyHmacSignature(BODY, sig, SECRET)).toBe(true);
  });
});

describe('verifySignature (v2 replay-protected scheme)', () => {
  const NOW = 1_800_000_000_000; // fixed "now" in ms

  it('accepts a v2 signature with a nonce and reports the scheme', () => {
    const sig = signWebhookBodyV2(BODY, SECRET, { timestampMs: NOW, nonce: 'abc-1' });
    expect(sig).toMatch(/^t=\d+,n=abc-1,v1=[a-f0-9]{64}$/);
    const v = verifySignature(BODY, sig, SECRET, { nowMs: NOW });
    expect(v).toEqual({ ok: true, scheme: 'v2' });
  });

  it('accepts a v2 signature without a nonce', () => {
    const sig = signWebhookBodyV2(BODY, SECRET, { timestampMs: NOW });
    expect(sig).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(verifySignature(BODY, sig, SECRET, { nowMs: NOW }).ok).toBe(true);
  });

  it('still accepts the legacy format and reports it', () => {
    const sig = signWebhookBody(BODY, SECRET);
    const v = verifySignature(BODY, sig, SECRET, { nowMs: NOW });
    expect(v).toEqual({ ok: true, scheme: 'legacy' });
  });

  it('rejects a v2 signature outside the timestamp tolerance (both directions)', () => {
    const driftMs = (SIGNATURE_TOLERANCE_SECONDS + 5) * 1000;
    const stale = signWebhookBodyV2(BODY, SECRET, { timestampMs: NOW - driftMs });
    const future = signWebhookBodyV2(BODY, SECRET, { timestampMs: NOW + driftMs });
    expect(verifySignature(BODY, stale, SECRET, { nowMs: NOW })).toEqual({
      ok: false,
      reason: 'timestamp outside tolerance',
    });
    expect(verifySignature(BODY, future, SECRET, { nowMs: NOW })).toEqual({
      ok: false,
      reason: 'timestamp outside tolerance',
    });
  });

  it('accepts drift inside the tolerance', () => {
    const sig = signWebhookBodyV2(BODY, SECRET, {
      timestampMs: NOW - (SIGNATURE_TOLERANCE_SECONDS - 5) * 1000,
    });
    expect(verifySignature(BODY, sig, SECRET, { nowMs: NOW }).ok).toBe(true);
  });

  it('rejects tampering with body, timestamp, or nonce', () => {
    const sig = signWebhookBodyV2(BODY, SECRET, { timestampMs: NOW, nonce: 'n1' });
    expect(verifySignature(BODY + 'x', sig, SECRET, { nowMs: NOW }).ok).toBe(false);
    const bumpedT = sig.replace(/^t=(\d+)/, (_, t) => `t=${Number(t) + 1}`);
    expect(verifySignature(BODY, bumpedT, SECRET, { nowMs: NOW }).ok).toBe(false);
    const swappedN = sig.replace('n=n1', 'n=n2');
    expect(verifySignature(BODY, swappedN, SECRET, { nowMs: NOW }).ok).toBe(false);
  });

  it('rejects a replayed nonce within the window', () => {
    const nonces = new NonceCache();
    const sig = signWebhookBodyV2(BODY, SECRET, { timestampMs: NOW, nonce: 'once' });
    expect(verifySignature(BODY, sig, SECRET, { nowMs: NOW, nonces }).ok).toBe(true);
    expect(verifySignature(BODY, sig, SECRET, { nowMs: NOW, nonces })).toEqual({
      ok: false,
      reason: 'nonce replay',
    });
  });

  it('allows a nonce again after its cache TTL expires', () => {
    const nonces = new NonceCache(1000); // 1s TTL for the test
    const sig1 = signWebhookBodyV2(BODY, SECRET, { timestampMs: NOW, nonce: 'n' });
    expect(verifySignature(BODY, sig1, SECRET, { nowMs: NOW, nonces }).ok).toBe(true);
    const later = NOW + 2000;
    const sig2 = signWebhookBodyV2(BODY, SECRET, { timestampMs: later, nonce: 'n' });
    expect(verifySignature(BODY, sig2, SECRET, { nowMs: later, nonces }).ok).toBe(true);
  });

  it('does NOT record a nonce from a request whose signature failed', () => {
    const nonces = new NonceCache();
    const bad = signWebhookBodyV2(BODY, 'wrong-secret', { timestampMs: NOW, nonce: 'poison' });
    expect(verifySignature(BODY, bad, SECRET, { nowMs: NOW, nonces }).ok).toBe(false);
    // The legitimate caller can still use that nonce.
    const good = signWebhookBodyV2(BODY, SECRET, { timestampMs: NOW, nonce: 'poison' });
    expect(verifySignature(BODY, good, SECRET, { nowMs: NOW, nonces }).ok).toBe(true);
  });

  it('rejects malformed v2 headers and missing secrets', () => {
    expect(verifySignature(BODY, undefined, SECRET).ok).toBe(false);
    expect(verifySignature(BODY, 't=123', SECRET, { nowMs: NOW }).ok).toBe(false); // no v1
    expect(verifySignature(BODY, 'v1=deadbeef', SECRET, { nowMs: NOW }).ok).toBe(false); // no t
    expect(verifySignature(BODY, 't=abc,v1=deadbeef', SECRET, { nowMs: NOW }).ok).toBe(false); // non-numeric t
    expect(verifySignature(BODY, 'garbage', SECRET, { nowMs: NOW }).ok).toBe(false);
    const sig = signWebhookBodyV2(BODY, SECRET, { timestampMs: NOW });
    expect(verifySignature(BODY, sig, '', { nowMs: NOW }).ok).toBe(false);
  });
});
