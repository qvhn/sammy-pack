/**
 * A2A agent-card signing + verification (JWS RS256).
 *
 * The A2A spec lets an agent card carry `signatures` so a caller can
 * authenticate WHO published the card before trusting its `url` endpoint.
 * Each entry mirrors the JWS JSON serialization: `{ protected, signature }`
 * where `protected` is the base64url JWS header (`{"alg":"RS256"}`) and
 * `signature` is the base64url RSA-SHA256 signature over
 * `<protected>.<payload>`, payload = base64url(canonical JSON of the card
 * minus its `signatures` field).
 *
 * Canonicalization is JCS-style — object keys sorted recursively, no
 * whitespace. (Full RFC 8785 number canonicalization is not implemented;
 * agent cards contain only strings / booleans / arrays / plain objects,
 * which sorted-key stringify canonicalizes exactly.)
 *
 * `node:crypto` is resolved at runtime via `process.getBuiltinModule` (no
 * import — same pattern as the code-node's `vm` lookup) so this module
 * stays safe to import from the executor bundle; signing/verification
 * simply fails off Node.
 */

import type { A2aAgentCard, A2aCardSignature } from './a2a';

type CryptoModule = typeof import('node:crypto');

/** node:crypto via a runtime lookup — undefined off Node. */
function getCrypto(): CryptoModule | undefined {
  const getBuiltin = (
    globalThis.process as unknown as {
      getBuiltinModule?: (id: string) => unknown;
    }
  )?.getBuiltinModule;
  return getBuiltin?.('node:crypto') as CryptoModule | undefined;
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

// NOTE: nothing in this module may touch Buffer / crypto at MODULE scope —
// a2a.ts imports this file statically and a2a.ts is in the browser bundle,
// where Buffer does not exist. All Node-only access stays inside the
// functions below, which only ever run server-side.
function b64url(input: string | Uint8Array): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** The JWS payload for a card: canonical JSON without `signatures`. */
function cardPayload(card: A2aAgentCard): string {
  const { signatures: _drop, ...rest } = card;
  return b64url(canonicalJson(rest));
}

function protectedHeader(): string {
  return b64url(JSON.stringify({ alg: 'RS256' }));
}

/** Return a copy of `card` with an RS256 signature appended. The private
 *  key is a PKCS#8 / PKCS#1 PEM string (e.g. from
 *  `openssl genrsa 2048`). Existing signatures are preserved. */
export async function signAgentCard(
  card: A2aAgentCard,
  privateKeyPem: string,
): Promise<A2aAgentCard> {
  const crypto = getCrypto();
  if (!crypto) throw new Error('A2A card signing requires a Node runtime');
  const { createSign } = crypto;
  const payload = cardPayload(card);
  const header = protectedHeader();
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`, 'utf8');
  const signature = b64url(signer.sign(privateKeyPem));
  const entry: A2aCardSignature = {
    protected: header,
    signature,
  };
  return { ...card, signatures: [...(card.signatures ?? []), entry] };
}

/** True if ANY of the card's signatures verifies against `publicKeyPem`
 *  (SPKI PEM). False for an unsigned card, a malformed entry, a tampered
 *  card, or a key mismatch — never throws. */
export async function verifyAgentCard(
  card: A2aAgentCard,
  publicKeyPem: string,
): Promise<boolean> {
  const sigs = card.signatures;
  if (!Array.isArray(sigs) || sigs.length === 0) return false;
  const crypto = getCrypto();
  if (!crypto) return false;
  const { createVerify } = crypto;
  const payload = cardPayload(card);
  for (const s of sigs) {
    if (typeof s?.protected !== 'string' || typeof s?.signature !== 'string') {
      continue;
    }
    // Only RS256 entries are ours; skip anything else.
    try {
      const header = JSON.parse(
        Buffer.from(s.protected, 'base64').toString('utf8'),
      ) as { alg?: string };
      if (header.alg !== 'RS256') continue;
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${s.protected}.${payload}`, 'utf8');
      const sigBuf = Buffer.from(
        s.signature.replace(/-/g, '+').replace(/_/g, '/'),
        'base64',
      );
      if (verifier.verify(publicKeyPem, sigBuf)) return true;
    } catch {
      // Malformed entry — try the next one.
    }
  }
  return false;
}
