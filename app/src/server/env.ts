/**
 * env — environment knobs (numbers, flags, lists, enums), read at the point
 * of USE.
 *
 * Two reasons this is a module rather than a one-liner in each file.
 *
 * 1. **Read-at-use, not captured at import.** A limit frozen at module load
 *    is a limit that cannot be changed by a test and that depends on import
 *    order. Every reader here re-reads `process.env`.
 *
 * 2. **A malformed value must not be silently ignored.** This was a live
 *    defect: `SAMMY_RUN_RETENTION_DAYS=14d` parsed to `NaN`, fell back to the
 *    default (retention OFF), and the boot banner then printed
 *    `retention: OFF (SAMMY_RUN_RETENTION_DAYS unset)` — reporting "unset"
 *    for a variable the operator had explicitly set. An operator who typed a
 *    unit suffix got no retention and a banner telling them they had not
 *    configured it. That is the project's own silent-divergence class inside
 *    the surface built to prevent it.
 *
 *    So a value that is PRESENT but unparseable warns, once per variable, and
 *    `envIsSetButInvalid` lets the banner say which.
 */

/** Variables we have already complained about, so a per-use read doesn't
 *  produce a warning per request. */
const warned = new Set<string>();

/** True when the variable is present and non-empty (whatever its value). */
export function envIsSet(name: string): boolean {
  const raw = process.env[name];
  return typeof raw === 'string' && raw.trim() !== '';
}

function rejectOnce(
  name: string,
  raw: string,
  expectation: string,
  consequence = 'IGNORING it and using the default',
): void {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(
    `[config] ${name}="${raw}" is not ${expectation} — ${consequence}. ` +
      'This variable is set, so the default is almost certainly not what ' +
      'you intended.',
  );
}

/** The spellings a boolean knob accepts, lower-cased and trimmed. */
const FLAG_ON = new Set(['1', 'true', 'yes', 'on']);
const FLAG_OFF = new Set(['0', 'false', 'no', 'off']);

/**
 * A boolean from the environment. Accepts `1/true/yes/on` and
 * `0/false/no/off` (trimmed, case-insensitive); unset or EMPTY is `false`.
 *
 * The flags that gate SECURITY posture (`SAMMY_REQUIRE_*`) used to compare
 * `=== '1'`, so `SAMMY_REQUIRE_SIGNED_TRIGGERS=true` — or `=1 ` with a
 * trailing space from a compose file — silently meant OFF: an operator who
 * believed they had closed a door had not. A PRESENT-but-unrecognised value
 * warns once; with `failClosed` it also counts as ENABLED, because for a
 * flag whose whole purpose is to refuse things, "the operator typed
 * something" must err towards refusing.
 *
 * "Present" is `raw !== undefined && raw !== ''`, NOT `envIsSet` (which also
 * discounts whitespace). An empty string is how a compose file leaves a knob
 * unset, so it stays silent — but `SAMMY_REQUIRE_AUTH_READS=' '` (a stray
 * space) is the operator typing something, and it used to mean OFF with no
 * warning: the exact silent-OFF the fail-closed rule exists to prevent.
 */
export function envFlag(
  name: string,
  opts?: { failClosed?: boolean },
): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return false;
  const v = raw.trim().toLowerCase();
  if (FLAG_ON.has(v)) return true;
  if (FLAG_OFF.has(v)) return false;
  const failClosed = opts?.failClosed === true;
  rejectOnce(
    name,
    raw,
    'a boolean (1/true/yes/on or 0/false/no/off)',
    failClosed
      ? 'treating it as ENABLED (this flag fails closed)'
      : 'IGNORING it and using the default',
  );
  return failClosed;
}

/**
 * A list from the environment: entries separated by commas, semicolons or
 * whitespace, trimmed, empties dropped. ONE grammar for every list-shaped
 * knob — the allowlists used to be parsed by three different splitters, so
 * a value that worked for one variable silently lost entries in another.
 * (Filesystem-path lists are the exception: a path may contain spaces, so
 * `import-roots.ts` keeps its own path-safe separators.)
 */
export function envList(name: string): string[] {
  if (!envIsSet(name)) return [];
  return (process.env[name] as string)
    .split(/[,;\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * One of `allowed`, or `fallback`. A set-but-unrecognised value warns once
 * (not once per request, which is what the per-request reader of the stream
 * permission mode used to do) and falls back.
 */
export function envEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (!envIsSet(name)) return fallback;
  const raw = process.env[name] as string;
  const v = raw.trim();
  if ((allowed as readonly string[]).includes(v)) return v as T;
  rejectOnce(name, raw, `one of ${allowed.join(' | ')}`);
  return fallback;
}

/**
 * The two numeric domains a knob can have, as ONE table the readers and the
 * banner's `envIsSetButInvalid` all consult — so "what the reader rejects"
 * and "what the banner calls INVALID" cannot disagree. They did: the banner
 * check accepted `>= 0` while `envPositiveInt` required `> 0`, so a `0`
 * handed to a positive-int knob warned at [config] (reader) but the banner
 * would have reported it as a plain "set", never as INVALID.
 */
const ACCEPT = {
  positive: (n: number) => Number.isFinite(n) && n > 0,
  'non-negative': (n: number) => Number.isFinite(n) && n >= 0,
} as const;
export type EnvNumberKind = keyof typeof ACCEPT;

/**
 * A positive integer from the environment, or `fallback`.
 *
 * A set-but-unparseable value warns once and then falls back, rather than
 * falling back silently.
 */
export function envPositiveInt(name: string, fallback: number): number {
  if (!envIsSet(name)) return fallback;
  const raw = process.env[name] as string;
  const n = Number(raw);
  if (ACCEPT.positive(n)) return Math.floor(n);
  rejectOnce(name, raw, 'a positive integer');
  return fallback;
}

/**
 * A non-negative integer (0 allowed, which several knobs use as "disabled").
 */
export function envNonNegativeInt(name: string, fallback: number): number {
  if (!envIsSet(name)) return fallback;
  const raw = process.env[name] as string;
  const n = Number(raw);
  if (ACCEPT['non-negative'](n)) return Math.floor(n);
  rejectOnce(name, raw, 'a non-negative integer');
  return fallback;
}

/**
 * True when the variable is set but is not a number of the given `kind` —
 * i.e. the operator configured something and the matching reader ignored it.
 * The boot banner uses this to print "set but INVALID" instead of "unset".
 *
 * `kind` must match the reader that consumes the variable: `'positive'` for
 * an `envPositiveInt` knob (where `0` IS invalid), `'non-negative'` for a
 * knob that treats `0` as "off" (the default — the retention-days banner
 * line, whose reader accepts 0 as disabled).
 */
export function envIsSetButInvalid(
  name: string,
  kind: EnvNumberKind = 'non-negative',
): boolean {
  if (!envIsSet(name)) return false;
  return !ACCEPT[kind](Number(process.env[name]));
}

/** Reset the warn-once memo. Tests only. */
export function _resetEnvWarningsForTests(): void {
  warned.clear();
}
