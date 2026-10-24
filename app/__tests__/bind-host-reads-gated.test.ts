/**
 * The bind warning tells the truth about reads.
 *
 * `describeBind` warned "reads on /api are NOT auth-gated unless
 * SAMMY_REQUIRE_AUTH_READS=1" on every non-loopback bind — including the
 * one posture where the operator had set exactly that. `serve.ts` now hands
 * it the flag it already reads.
 *
 * And the flag ALONE was then handed over, which claims a posture the server
 * may not have: with no token and no verifier `mountSammyApi` builds neither
 * gate, the banner prints "reads GATED IN NAME ONLY", and the warning said
 * reads were gated. The posture reader lives in the module (serve.ts cannot
 * be imported by a test), so both halves are pinned here.
 */

import { describeBind, readPostureFromEnv } from '../src/server/bind-host';

describe('describeBind and gated reads', () => {
  it('says reads are open when they are', () => {
    const { warning } = describeBind('0.0.0.0', 5173);
    expect(warning).toContain('NOT auth-gated unless SAMMY_REQUIRE_AUTH_READS=1');
    expect(describeBind('0.0.0.0', 5173, { readsGated: false }).warning).toContain('NOT auth-gated');
  });

  it('says reads are gated when they are — the clause the warning used to contradict', () => {
    const { warning } = describeBind('192.168.1.10', 5173, { readsGated: true });
    expect(warning).toContain('Reads on /api are gated (SAMMY_REQUIRE_AUTH_READS=1)');
    expect(warning).not.toContain('NOT auth-gated');
    // Still a warning: the bind is still an exposure decision.
    expect(warning).toMatch(/bound to 192\.168\.1\.10/);
  });

  it('says GATED IN NAME ONLY when nothing exists to gate them with', () => {
    // The posture the boot banner already prints as "reads GATED IN NAME
    // ONLY": the flag is set and no token and no verifier exists, so
    // mountSammyApi builds neither gate and every read is open. The fix for
    // the false negative above introduced this false POSITIVE — on the one
    // line whose job is to say what has just been exposed.
    const { warning } = describeBind('0.0.0.0', 5173, {
      readsGated: true,
      gateConfigured: false,
    });
    expect(warning).toContain('gated IN NAME ONLY');
    expect(warning).toContain('SAMMY_API_TOKEN');
    expect(warning).toContain('every read is open');
    expect(warning).not.toContain('are gated (SAMMY_REQUIRE_AUTH_READS=1)');
  });

  it('loopback never warns, gated or not', () => {
    expect(describeBind('127.0.0.1', 5173, { readsGated: true }).warning).toBeNull();
    expect(
      describeBind('127.0.0.1', 5173, { readsGated: true, gateConfigured: false }).warning,
    ).toBeNull();
  });
});

describe('readPostureFromEnv — what the warning is allowed to claim', () => {
  const KEYS = [
    'SAMMY_REQUIRE_AUTH_READS',
    'SAMMY_API_TOKEN',
    'SAMMY_JWKS_URI',
    'SAMMY_JWT_PUBLIC_KEY',
    'SAMMY_JWT_SECRET',
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('the flag alone is NOT a gated posture', () => {
    process.env.SAMMY_REQUIRE_AUTH_READS = '1';
    expect(readPostureFromEnv()).toEqual({ readsGated: true, gateConfigured: false });
    const { warning } = describeBind('0.0.0.0', 5173, readPostureFromEnv());
    expect(warning).toContain('gated IN NAME ONLY');
  });

  it('a token or any verifier makes it one', () => {
    process.env.SAMMY_REQUIRE_AUTH_READS = '1';
    for (const k of ['SAMMY_API_TOKEN', 'SAMMY_JWKS_URI', 'SAMMY_JWT_PUBLIC_KEY', 'SAMMY_JWT_SECRET']) {
      process.env[k] = 'set';
      expect(`${k}: ${readPostureFromEnv().gateConfigured}`).toBe(`${k}: true`);
      const { warning } = describeBind('0.0.0.0', 5173, readPostureFromEnv());
      expect(warning).toContain('Reads on /api are gated (SAMMY_REQUIRE_AUTH_READS=1)');
      delete process.env[k];
    }
  });

  it('reads the flag through the shared reader, so `yes` means on here too', () => {
    process.env.SAMMY_REQUIRE_AUTH_READS = 'yes';
    expect(readPostureFromEnv().readsGated).toBe(true);
    delete process.env.SAMMY_REQUIRE_AUTH_READS;
    expect(readPostureFromEnv().readsGated).toBe(false);
  });
});
