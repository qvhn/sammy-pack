/**
 * bind-host — what the server should print, and whether it should warn, for
 * the address it listens on.
 *
 * `serve.ts` printed `http://localhost:<port>` for every bind except
 * `0.0.0.0` / `::`, and warned only for those two. An operator who set
 * `SAMMY_BIND_HOST=192.168.1.10` — a real interface, reachable from the whole
 * LAN — got a log line claiming localhost and no warning: the "surfaces agree
 * with each other and disagree with the code" failure the loopback default
 * was introduced to end, reproduced one case over. The rule is simpler than
 * the special cases were: loopback is private; anything else is exposure,
 * and the log says which address it actually is.
 *
 * Pure (a host + port in, strings out) so it is unit-testable without
 * binding a socket — `serve.ts` runs `main()` at import and cannot be loaded
 * by a test. For the same reason the read-posture it is called WITH is read
 * from the environment here rather than at the call site.
 */

import { envFlag, envIsSet } from './env';

/** True for the addresses only this machine can reach: `localhost`, the
 *  whole 127/8 block, IPv6 `::1` and its IPv4-mapped form. Accepts an IPv6
 *  literal with or without URL brackets. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h === '::1' ||
    h === '::ffff:127.0.0.1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

/** What `describeBind` can be told about reads, read from the environment:
 *  the flag, and whether anything exists to ENFORCE it — the same two sources
 *  `mountSammyApi` builds its gates from. The flag alone gates nothing, so a
 *  caller passing it by itself makes the warning claim a posture the server
 *  does not have. */
export function readPostureFromEnv(): {
  readsGated: boolean;
  gateConfigured: boolean;
} {
  return {
    readsGated: envFlag('SAMMY_REQUIRE_AUTH_READS', { failClosed: true }),
    gateConfigured:
      envIsSet('SAMMY_API_TOKEN') ||
      envIsSet('SAMMY_JWKS_URI') ||
      envIsSet('SAMMY_JWT_PUBLIC_KEY') ||
      envIsSet('SAMMY_JWT_SECRET'),
  };
}

/**
 * The URL to print for a bind and, for any non-loopback bind, the warning to
 * print with it (`null` for loopback). The URL names the REAL host — an IPv6
 * literal gets its URL brackets — never a stand-in.
 *
 * `readsGated` is whether SAMMY_REQUIRE_AUTH_READS is in effect: the warning
 * used to claim reads were open on every non-loopback bind, including the one
 * posture where they are not, so a hardened operator was told their own
 * setting had not taken.
 *
 * `gateConfigured` is whether anything exists to gate them WITH — a token or
 * a JWT verifier. The flag alone gates nothing, and the boot banner says so
 * on the same boot ("reads GATED IN NAME ONLY"), so the one line whose job is
 * to name what has just been exposed must not claim otherwise. Omitted means
 * the caller does not know of a gap; `false` is the posture the banner warns
 * about.
 */
export function describeBind(
  host: string,
  port: number,
  opts?: { readsGated?: boolean; gateConfigured?: boolean },
): { url: string; warning: string | null } {
  const bare = host.trim().replace(/^\[|\]$/g, '');
  const shown = bare.includes(':') ? `[${bare}]` : bare;
  const url = `http://${shown}:${port}`;
  if (isLoopbackHost(bare)) return { url, warning: null };
  // Say it out loud: a non-loopback bind is a real exposure decision, not a
  // detail — whether it is every interface or one specific one — and, unless
  // reads are gated, GET routes answer anyone who can reach the port.
  const scope =
    bare === '0.0.0.0' || bare === '::'
      ? 'all interfaces'
      : 'a non-loopback interface, reachable from its network';
  const reads = !opts?.readsGated
    ? 'Reads on /api are NOT auth-gated unless SAMMY_REQUIRE_AUTH_READS=1'
    : opts.gateConfigured === false
      ? 'Reads on /api are gated IN NAME ONLY — SAMMY_REQUIRE_AUTH_READS=1 ' +
        'is set but there is no SAMMY_API_TOKEN and no JWT verifier ' +
        '(SAMMY_JWT_SECRET / SAMMY_JWT_PUBLIC_KEY / SAMMY_JWKS_URI) to gate ' +
        'them with, so every read is open'
      : 'Reads on /api are gated (SAMMY_REQUIRE_AUTH_READS=1)';
  return {
    url,
    warning:
      `bound to ${bare} (${scope}). ${reads} — put this behind a network ` +
      'boundary or a reverse proxy.',
  };
}
