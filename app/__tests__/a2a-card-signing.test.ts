import { generateKeyPairSync } from 'node:crypto';
import {
  canonicalJson,
  signAgentCard,
  verifyAgentCard,
} from '../src/llm/a2a-card-signing';
import { fetchAgentCard, type A2aAgentCard } from '../src/llm/a2a';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function makeCard(): A2aAgentCard {
  return {
    protocolVersion: '0.3.0',
    name: 'flow',
    description: 'a card',
    url: 'http://host/api/a2a/flow',
    preferredTransport: 'JSONRPC',
    version: '1.0.0',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
  };
}

describe('canonicalJson', () => {
  it('is stable under key order and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: 'x', c: undefined })).toBe(
      canonicalJson({ a: 'x', b: 1 }),
    );
    expect(canonicalJson({ a: [{ z: true, y: null }] })).toBe(
      '{"a":[{"y":null,"z":true}]}',
    );
  });
});

describe('A2A card signing (JWS RS256)', () => {
  it('sign → verify roundtrips', async () => {
    const signed = await signAgentCard(makeCard(), privateKey);
    expect(signed.signatures).toHaveLength(1);
    await expect(verifyAgentCard(signed, publicKey)).resolves.toBe(true);
  });

  it('rejects a tampered card (endpoint swap)', async () => {
    const signed = await signAgentCard(makeCard(), privateKey);
    const tampered = { ...signed, url: 'http://attacker/api/a2a/flow' };
    await expect(verifyAgentCard(tampered, publicKey)).resolves.toBe(false);
  });

  it('rejects a wrong key and an unsigned card', async () => {
    const other = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const signed = await signAgentCard(makeCard(), privateKey);
    await expect(verifyAgentCard(signed, other.publicKey)).resolves.toBe(false);
    await expect(verifyAgentCard(makeCard(), publicKey)).resolves.toBe(false);
  });

  it('verification is order-insensitive (canonical payload)', async () => {
    const signed = await signAgentCard(makeCard(), privateKey);
    // Reorder the top-level keys — verification must still pass.
    const reordered = Object.fromEntries(
      Object.entries(signed).reverse(),
    ) as unknown as A2aAgentCard;
    await expect(verifyAgentCard(reordered, publicKey)).resolves.toBe(true);
  });
});

describe('fetchAgentCard pinned-publisher verification', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.SAMMY_A2A_REMOTE_PUBLIC_KEY;
  });

  function jsonResponse(body: unknown) {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
    } as unknown as Response;
  }

  it('refuses an unsigned card when a key is pinned, accepts a signed one', async () => {
    process.env.SAMMY_A2A_REMOTE_PUBLIC_KEY = publicKey;

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(makeCard())) as unknown as typeof fetch;
    await expect(fetchAgentCard('http://remote/card.json')).rejects.toThrow(
      /failed signature verification/,
    );

    const signed = await signAgentCard(makeCard(), privateKey);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(signed)) as unknown as typeof fetch;
    await expect(
      fetchAgentCard('http://remote/card.json'),
    ).resolves.toMatchObject({ name: 'flow' });
  });
});
