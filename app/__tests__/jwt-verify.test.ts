import { signJwtHS256, verifyJwtHS256 } from '../src/server/jwt-verify';

const SECRET = 'shhh-very-secret';

describe('verifyJwtHS256 (A2 verified identity)', () => {
  it('accepts a well-formed token and returns claims', () => {
    const tok = signJwtHS256({ sub: 'alice', role: 'admin' }, SECRET);
    const r = verifyJwtHS256(tok, SECRET);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.sub).toBe('alice');
      expect(r.claims.role).toBe('admin');
    }
  });

  it('rejects a wrong secret (signature mismatch)', () => {
    const tok = signJwtHS256({ sub: 'alice' }, SECRET);
    const r = verifyJwtHS256(tok, 'other-secret');
    expect(r).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('rejects a tampered payload', () => {
    const tok = signJwtHS256({ sub: 'alice' }, SECRET);
    const [h, , s] = tok.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'mallory' }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifyJwtHS256(`${h}.${forged}.${s}`, SECRET).ok).toBe(false);
  });

  it('rejects an expired token but accepts before exp', () => {
    const tok = signJwtHS256({ sub: 'a', exp: 1000 }, SECRET);
    expect(verifyJwtHS256(tok, SECRET, { now: 2000_000 }).ok).toBe(false); // now=2000s > exp
    expect(verifyJwtHS256(tok, SECRET, { now: 500_000 }).ok).toBe(true); // now=500s < exp
  });

  it('rejects a not-yet-valid (nbf) token', () => {
    const tok = signJwtHS256({ sub: 'a', nbf: 5000 }, SECRET);
    expect(verifyJwtHS256(tok, SECRET, { now: 1000_000 }).ok).toBe(false); // now=1000s < nbf
  });

  it('rejects malformed / non-HS256 / empty', () => {
    expect(verifyJwtHS256('', SECRET).ok).toBe(false);
    expect(verifyJwtHS256('a.b', SECRET).ok).toBe(false);
    // alg=none style header
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none' }))
      .toString('base64url');
    expect(verifyJwtHS256(`${noneHeader}.e30.`, SECRET).ok).toBe(false);
  });
});
