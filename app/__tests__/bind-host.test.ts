/**
 * The standalone server's bind log tells the truth about where it listens.
 *
 * `serve.ts` printed `http://localhost:<port>` for every bind except
 * `0.0.0.0` / `::`, and warned only for those two — so an operator who bound a
 * specific LAN interface saw "localhost" and no warning for a server their
 * whole network could reach. The rule is now: loopback is private, every
 * other address is exposure, and the URL names the real host.
 *
 * Tested through the pure `describeBind` helper because `serve.ts` runs
 * `main()` at import and binds a socket; the one line that calls the helper
 * is covered by typecheck.
 */

import { describeBind, isLoopbackHost } from '../src/server/bind-host';

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]', '::ffff:127.0.0.1'])(
    '%s is loopback',
    host => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', '172.16.0.1', 'example.internal', '128.0.0.1'])(
    '%s is NOT loopback',
    host => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

describe('describeBind', () => {
  it('prints loopback binds as-is with no warning', () => {
    expect(describeBind('127.0.0.1', 5173)).toEqual({
      url: 'http://127.0.0.1:5173',
      warning: null,
    });
    expect(describeBind('localhost', 8080)).toEqual({
      url: 'http://localhost:8080',
      warning: null,
    });
  });

  it('brackets an IPv6 literal in the URL', () => {
    expect(describeBind('::1', 5173).url).toBe('http://[::1]:5173');
    expect(describeBind('::', 5173).url).toBe('http://[::]:5173');
  });

  it('warns for an all-interfaces bind and names it', () => {
    const v4 = describeBind('0.0.0.0', 5173);
    expect(v4.url).toBe('http://0.0.0.0:5173');
    expect(v4.warning).toMatch(/bound to 0\.0\.0\.0 \(all interfaces\)/);
    expect(v4.warning).toMatch(/SAMMY_REQUIRE_AUTH_READS/);
    expect(describeBind('::', 5173).warning).toMatch(/all interfaces/);
  });

  it('warns for a SPECIFIC non-loopback interface and prints the real host, not localhost', () => {
    // The case the old code got wrong on both counts.
    const lan = describeBind('192.168.1.10', 5173);
    expect(lan.url).toBe('http://192.168.1.10:5173');
    expect(lan.url).not.toContain('localhost');
    expect(lan.warning).not.toBeNull();
    expect(lan.warning).toMatch(/bound to 192\.168\.1\.10/);
    expect(lan.warning).toMatch(/non-loopback/);
    expect(lan.warning).toMatch(/SAMMY_REQUIRE_AUTH_READS/);
  });
});
