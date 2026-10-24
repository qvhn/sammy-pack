/**
 * Who may run what through `code.run`.
 *
 * Two modes, both opt-in (code.run is off by default):
 *
 *   SAMMY_ALLOW_CODE_RUN=1  — UNRESTRICTED: any command, through a shell.
 *   SAMMY_CODE_RUN_ALLOW    — ALLOWLISTED: only commands matching one of the
 *                             listed patterns, and executed WITHOUT a shell.
 *
 * The allowlist is newline- or `;`-separated patterns over the RESOLVED
 * command (after `${…}` interpolation). Matching is PER ARGUMENT: the command
 * and the pattern are both split into argv (single / double quotes and
 * backslashes honored), they must have the same number of arguments, and
 * each argument must match its pattern argument, where `*` matches any
 * characters WITHIN that one argument — `npx jest *`, `mvn -q -Dtest=* test`.
 * An argument that a wildcard supplies from its very first character may not
 * start with `-`, so a value can't smuggle in an option (`--config=…`,
 * `-f evil.xml`), nor contain a `..` path segment (`./scripts/*` cannot reach
 * `./scripts/../../bin/sh`). The command is then spawned directly from that argv, so
 * shell syntax in it — `;`, `&&`, `|`, `$(…)`, redirects — is a literal
 * argument, never executed. That is what makes the allowlist mean something
 * when a pattern's `*` is filled from run state that came from an event.
 * Commands needing environment variables use `${worktrees.<name>.path}`
 * interpolation, or the cwd the run's worktree provides.
 *
 * Windows: with no shell, `npx` / `npm` / `mvn` (`.cmd` shims) cannot be
 * spawned — allow the real executable (`node node_modules/jest/bin/jest.js *`)
 * or use unrestricted mode there.
 *
 * Browser-safe (no Node imports).
 */

type Env = Record<string, string | undefined>;

const readEnv = (): Env =>
  (globalThis.process as { env?: Env } | undefined)?.env ?? {};

export type CodeRunMode = 'off' | 'unrestricted' | 'allowlist';

export function codeRunAllowlist(env: Env = readEnv()): string[] {
  return (env.SAMMY_CODE_RUN_ALLOW ?? '')
    .split(/[\n;]+/)
    .map(p => p.trim())
    .filter(Boolean);
}

export function codeRunMode(env: Env = readEnv()): CodeRunMode {
  const v = env.SAMMY_ALLOW_CODE_RUN;
  if (v === '1' || v === 'true') return 'unrestricted';
  return codeRunAllowlist(env).length > 0 ? 'allowlist' : 'off';
}

/** Variables a command always gets when an env allowlist is in force — what
 *  a tool needs to find itself and a temp dir, nothing secret. */
export const CODE_RUN_BASE_ENV = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'SystemRoot', 'ComSpec', 'PATHEXT'];

/** `SAMMY_CODE_RUN_ENV`: the names (comma / space separated) a code.run child
 *  may inherit from the server's environment, on top of the base set. Unset
 *  = inherit everything (the historical behavior). */
export function codeRunEnvAllowlist(env: Env = readEnv()): string[] | null {
  const raw = env.SAMMY_CODE_RUN_ENV;
  if (raw === undefined) return null;
  return raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

/** The environment a code.run child gets: the whole server env, or — with
 *  an allowlist — only the base set + the listed names. `extra` (the run's
 *  worktree paths) is always added. */
export function codeRunChildEnv(
  extra: Record<string, string>,
  env: Env = readEnv(),
): Record<string, string | undefined> {
  const allow = codeRunEnvAllowlist(env);
  if (allow === null) return { ...env, ...extra };
  const out: Record<string, string | undefined> = {};
  for (const k of [...CODE_RUN_BASE_ENV, ...allow]) {
    if (env[k] !== undefined) out[k] = env[k];
  }
  return { ...out, ...extra };
}

function tokenToRegExp(token: string): RegExp {
  const parts = token.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`, 's');
}

/** One command argument against one pattern argument. */
function argMatches(arg: string, patternArg: string): boolean {
  if (!tokenToRegExp(patternArg).test(arg)) return false;
  // A wildcard that supplies the argument's FIRST character must not supply
  // an option: `*` against `--outputFile=/x` is refused, while a literal
  // `-Dtest=*` (the option is the author's) is fine.
  if (patternArg.startsWith('*') && arg.startsWith('-')) return false;
  // Nor may it climb out of a directory the author named: `./scripts/*`
  // against `./scripts/../../bin/sh` is refused.
  if (patternArg.includes('*') && arg.split(/[\\/]/).includes('..')) return false;
  return true;
}

/** The first allowlist pattern the command matches, argument by argument,
 *  or null. An unparseable command or pattern never matches. */
export function matchAllowlist(command: string, patterns: readonly string[]): string | null {
  let argv: string[];
  try {
    argv = splitArgv(command);
  } catch {
    return null;
  }
  for (const p of patterns) {
    let pargv: string[];
    try {
      pargv = splitArgv(p);
    } catch {
      continue;
    }
    if (pargv.length !== argv.length || pargv.length === 0) continue;
    if (pargv.every((pa, i) => argMatches(argv[i], pa))) return p;
  }
  return null;
}

/**
 * Split a command into argv like a POSIX shell's word splitting, WITHOUT any
 * expansion: quotes group, backslash escapes, and every shell operator is
 * just a character. Throws on an unterminated quote.
 */
export function splitArgv(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) {
        cur += command[i + 1];
        i += 1;
      } else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === '\\' && i + 1 < command.length) {
      cur += command[i + 1];
      i += 1;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) {
        out.push(cur);
        cur = '';
        inWord = false;
      }
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (quote) throw new Error(`unterminated ${quote} quote in command`);
  if (inWord) out.push(cur);
  return out;
}
