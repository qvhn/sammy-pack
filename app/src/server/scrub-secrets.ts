/**
 * Secret scrubber — last line of defence for the credential-injection
 * security invariant.
 *
 * A credential's secret value must never appear in the event log / run
 * store or any API response. The PRIMARY guarantee is structural: a
 * resolved secret only ever flows into the agent subprocess's OS env (see
 * credential-env.ts), never into prompt text or model context. But an
 * agent can still ECHO an injected secret back into its own stdout — e.g.
 * `echo $JIRA_API_TOKEN`, a curl `-v` that prints the Authorization
 * header, or a stack trace that interpolates an env var. Those land in
 * tool-result / phase output text that we persist + stream. This module
 * redacts them before they're written.
 *
 * Two redaction layers:
 *   1. Known token PATTERNS (provider/key prefixes + long opaque blobs) —
 *      catches secrets even when no run is active or the value wasn't
 *      injected by us.
 *   2. LITERAL active values — the exact secret strings injected into the
 *      current run's agents, passed in by the caller. Catches custom-format
 *      tokens (e.g. a self-hosted Jira PAT) that match no known pattern.
 *
 * Server-only. Domain-agnostic.
 */

const REDACTED = '[REDACTED]';

/** Known secret token patterns. Anchored on widely-used, high-entropy
 *  prefixes so we don't over-redact ordinary prose. Each alternative is
 *  written to match the secret BODY following its prefix. Order doesn't
 *  matter — they're combined into one alternation.
 *
 *  Covered:
 *   - sk-ant-…           Anthropic API keys
 *   - sk-… / sk-proj-…   OpenAI API keys
 *   - ghp_/gho_/ghu_/ghs_/ghr_…  GitHub tokens (PAT, OAuth, user, server, refresh)
 *   - github_pat_…       GitHub fine-grained PATs
 *   - glpat-…            GitLab personal access tokens
 *   - xox[bporas]-…      Slack tokens
 *   - ATATT… / ATCTT…    Atlassian API tokens (Jira/Confluence)
 *   - AKIA…/ASIA…        AWS access key ids (16 uppercase alnum after prefix)
 *   - AIza…              Google API keys
 *   - figd_…             Figma personal access tokens
 *   - lin_api_… / lin_oauth_…  Linear API keys
 *   - secret_…           Notion integration secrets (ntn_ newer / secret_ legacy)
 *   - long base64/hex blobs (40+ chars) — generic high-entropy fallback,
 *     kept separate (GENERIC_BLOB + looksRandom below) because a run of the
 *     same characters is also what a kebab-case id or a file path is
 */
const TOKEN_PATTERNS: RegExp[] = [
  // sk-ant-… (Anthropic) and sk-… / sk-proj-… (OpenAI). The body is
  // alnum + _ - and reasonably long.
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  // GitHub classic + app tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  // GitHub fine-grained PATs.
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // GitLab PATs.
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  // Slack tokens.
  /\bxox[bporas]-[A-Za-z0-9-]{10,}/g,
  // Atlassian API tokens (Jira / Confluence).
  /\bAT(?:ATT|CTT)[A-Za-z0-9._=-]{16,}/g,
  // AWS access key ids — prefix + exactly 16 uppercase alnum.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
  // Google API keys.
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  // Figma PATs.
  /\bfigd_[A-Za-z0-9_-]{20,}/g,
  // Linear API keys.
  /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/g,
  // Notion integration secrets (legacy `secret_` and newer `ntn_`).
  /\b(?:secret_|ntn_)[A-Za-z0-9]{32,}/g,
];

/** Generic high-entropy fallback: a long run of base64url / hex characters.
 *  40+ chars catches most opaque bearer blobs, but kebab-case ids and file
 *  paths are 40+ runs of the same characters
 *  (`report-incoming-message-reasons-then-back-out`,
 *  `Users/me/git/app/tmp/screenshots/run-2026-10-26-full`), so a match only
 *  counts when it also `looksRandom`. Applied after TOKEN_PATTERNS. */
const GENERIC_BLOB = /\b[A-Za-z0-9+/_-]{40,}={0,2}/g;

/** Does a GENERIC_BLOB match look like a random token rather than words
 *  joined by separators? Random tokens have a long unbroken alphanumeric
 *  stretch (hex digests, base64 bodies) or mix upper case, lower case and
 *  digits over a fair stretch; identifiers and paths are short words split
 *  by `-` `/` `_` `+`. */
function looksRandom(s: string): boolean {
  const longest = Math.max(0, ...s.split(/[+/_=-]+/).map(r => r.length));
  if (longest >= 32) return true;
  return longest >= 16 && /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s);
}

/** Replace every GENERIC_BLOB match that `looksRandom`. */
function scrubGenericBlobs(text: string): string {
  GENERIC_BLOB.lastIndex = 0;
  const out = text.replace(GENERIC_BLOB, m => (looksRandom(m) ? REDACTED : m));
  GENERIC_BLOB.lastIndex = 0;
  return out;
}

/** Does `value` contain a token any pattern above recognises? The registry
 *  masker (credentials-store.ts) asks this about a config leaf that sits
 *  under a NON-secret key — a positional `ghp_…` in an MCP server's argv —
 *  so the list the GET surface masks with and the list the run log redacts
 *  with are the same list, never two that drift. The patterns are
 *  module-level `/g` regexes: `test()` advances `lastIndex`, so it is reset
 *  on both sides of the call or a second string is scanned from the middle. */
export function looksLikeKnownToken(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  for (const re of TOKEN_PATTERNS) {
    re.lastIndex = 0;
    const hit = re.test(value);
    re.lastIndex = 0;
    if (hit) return true;
  }
  return scrubGenericBlobs(value) !== value;
}

/** Escape a literal string for safe embedding in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redact secrets from `text`.
 *
 * @param text         The text to scrub (event detail, tool-result, phase
 *                     output). Non-strings are returned as-is.
 * @param extraValues  Literal secret values active in the current run
 *                     (the exact strings injected into agent envs). Each is
 *                     redacted by exact substring match — this catches
 *                     custom-format tokens that no pattern would. Empty /
 *                     short ( < 6 chars, to avoid redacting noise) values
 *                     are ignored.
 *
 * Returns the scrubbed text. Idempotent-ish: re-scrubbing already-redacted
 * text is a no-op for the literals; `[REDACTED]` itself matches no pattern.
 */
/**
 * Env vars whose VALUES are secrets belonging to the server itself.
 *
 * Agent and `code.run` subprocesses inherit the server's environment (a
 * deliberate decision — an agent gets everything the platform was given, and
 * the operator owns that risk for connection data they supply). But INHERITING
 * a secret and PERSISTING it in the durable run log are different things: an
 * agent that echoes `$SAMMY_API_TOKEN` into its output used to land that token
 * in `events`, in the SSE stream, in an exported trace, and in the UI. These
 * are not in the run's `injectedSecrets` set — that only collects per-phase
 * credential values — so no layer caught them unless they happened to match a
 * token pattern, which a human-chosen `SAMMY_API_TOKEN` or a short HS256
 * secret does not.
 *
 * Read at each use, so a test can set them and a late-configured value is
 * still covered.
 *
 * Two rules decide what counts. The explicit list below names the secrets
 * the platform itself reads, whatever they are called. The NAME-SHAPE rule
 * after it covers everything else the operator put in the environment for
 * agents to use — a `GITHUB_TOKEN`, a `JIRA_API_TOKEN`, a `DB_PASSWORD` —
 * which the list could never enumerate: those are the operator's choice, and
 * a human-chosen value that matches no token prefix and is shorter than the
 * generic-blob floor used to reach events, SSE, traces and the UI the moment
 * an agent echoed it.
 */
const SERVER_SECRET_ENV_VARS = [
  'SAMMY_API_TOKEN',
  'SAMMY_WEBHOOK_SECRET',
  'SAMMY_JWT_SECRET',
  'SAMMY_A2A_SIGNING_KEY',
  'DATABASE_URL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  // Not secret-NAMED, but a secret: knowing it reverses `scrub.hashFields`.
  'SAMMY_SCRUB_SALT',
] as const;

/** A NAME that says its value is a secret — an env var here, a key in a
 *  free-form config (an MCP server's `env` / `headers`) in
 *  credentials-store.ts. ONE vocabulary, exported: the names the registry's
 *  GET surface masks and the names the run log redacts were two lists, and
 *  a value one side treated as secret could reach the other verbatim.
 *  Case-insensitive so `github_token` and `GITHUB_TOKEN` are treated alike.
 *  Deliberately broad (a bare KEY, AUTHORIZATION) — redacting a `PUBLIC_KEY`
 *  is noise, missing a `GITHUB_TOKEN` is a leak.
 *
 *  `PWD`, `PASS` and `AUTH` count only as a SUFFIX after a separator
 *  (`MYSQL_PWD`, `DB_PASS`, `REDIS_AUTH`, `X-Auth`) — the canonical DB-client
 *  and proxy names the unanchored list missed, so a `MYSQL_PWD` left
 *  GET /api/mcp-servers verbatim while `PGPASSWORD` was masked. Bare, they
 *  would match the shell's own `PWD` (the cwd — every path in every agent
 *  log), `SSH_AUTH_SOCK`, `GIT_AUTHOR_NAME` and `SAMMY_REQUIRE_AUTH_READS`.
 *  `SESSION` is left out for the same reason (`TERM_SESSION_ID`, every
 *  `*_SESSION_ID`); a `SESSION_TOKEN` / `SESSION_COOKIE` is caught by its
 *  other word. */
export const SECRET_NAME_SHAPE =
  /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|KEY|AUTHORIZATION|CREDENTIAL|COOKIE|[_-](?:PWD|PASS|AUTH)$)/i;

/** Names that match the shape but hold a knob, a count or a location, not a
 *  secret — e.g. the repo's own `SAMMY_MAX_AGENT_TOKENS` (a token COUNT) and
 *  `SAMMY_PG_STATEMENT_TIMEOUT_MS`. Redacting "6000000" wherever it appears
 *  in agent output would be noise, and a path to a token file is not the
 *  token. `_NAME` / `_DOMAIN` are what `COOKIE` pulls in (`COOKIE_NAME`,
 *  `COOKIE_DOMAIN`) — and a `SECRET_NAME` is the name of a secret in a
 *  vault, not the secret.
 *
 *  Every carve-out here says the value MEASURES or NAMES a secret rather
 *  than being one, which holds however strong the matching word is: a
 *  `JWT_SECRET_FILE` is still a path. */
const NOT_A_SECRET_NAME_SHAPE =
  /(_MAX_|_TIMEOUT|_MS$|_SEC$|_SECONDS$|_DAYS$|_BYTES$|_COUNT$|_LIMIT$|_TTL|_FILE$|_PATH$|_DIR$|_CLAIM$|_NAME$|_DOMAIN$)/i;

/** A carve-out that holds only for the vocabulary's WEAK words. `_HEADER$`
 *  was written for a knob naming the header that CARRIES a credential
 *  (`SAMMY_TOKEN_HEADER=X-Sammy-Token`) — a header name, not a secret. But
 *  it was applied as a veto after the whole vocabulary had matched, so it
 *  also beat AUTHORIZATION, the one word in the list that names the
 *  credential itself: an `AUTHORIZATION_HEADER` holding `Basic …` joined no
 *  redaction set and reached events, SSE, traces and the UI verbatim the
 *  moment an agent echoed it — the exact class the name rule exists for. */
const NOT_A_SECRET_UNLESS_STRONGLY_NAMED_SHAPE = /(_HEADER$)/i;

/** The words that name the SECRET ITSELF, not a thing that refers to one.
 *  A weak-word carve-out may not overrule them. `TOKEN`, `KEY` and `COOKIE`
 *  are deliberately absent: a `TOKEN_HEADER` / `KEY_HEADER` /
 *  `COOKIE_HEADER` really is a header name. */
const STRONG_SECRET_NAME_SHAPE =
  /(SECRET|PASSWORD|PASSWD|PASSPHRASE|AUTHORIZATION|CREDENTIAL)/i;

/** Does this NAME say its value is a secret? `SECRET_NAME_SHAPE` minus the
 *  carve-outs, with the strong words winning over the weak-word ones.
 *  The two rules were applied as one `test() && !test()` pair, which let
 *  the weakest carve-out overrule the strongest word. */
function isSecretName(name: string): boolean {
  if (!SECRET_NAME_SHAPE.test(name)) return false;
  if (NOT_A_SECRET_NAME_SHAPE.test(name)) return false;
  if (!NOT_A_SECRET_UNLESS_STRONGLY_NAMED_SHAPE.test(name)) return true;
  return STRONG_SECRET_NAME_SHAPE.test(name);
}

/** Floor for a name-shape match. Lower and ordinary words ("password") in
 *  an operator's `DB_PASSWORD=secret` would redact themselves out of prose;
 *  the explicit list keeps its looser 6 because those names are ours. */
const MIN_SHAPE_SECRET_LENGTH = 8;

/** The live values of the server's own secrets, for redaction. */
export function serverSecretValues(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (v: string | undefined, min: number): void => {
    if (typeof v !== 'string') return;
    const t = v.trim();
    if (t.length >= min && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  for (const name of SERVER_SECRET_ENV_VARS) add(process.env[name], 6);
  for (const [name, v] of Object.entries(process.env)) {
    if (isSecretName(name)) add(v, MIN_SHAPE_SECRET_LENGTH);
  }
  // Longest first, so a value that is a substring of another never leaves
  // a dangling tail (same discipline as the per-run literals below).
  return out.sort((a, b) => b.length - a.length);
}

export function scrubSecrets(
  text: string,
  extraValues?: Iterable<string>,
): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;

  // The server's OWN secrets, always — independent of whether the caller
  // passed a per-run secret set. See SERVER_SECRET_ENV_VARS.
  for (const v of serverSecretValues()) {
    out = out.replace(new RegExp(escapeRegExp(v), 'g'), REDACTED);
  }

  // Layer 2 FIRST: redact the exact active values. Doing this before the
  // pattern pass means a known-format active token is replaced by its
  // literal match (clean), and the pattern pass then has less to do. Sort
  // longest-first so a value that's a substring of another doesn't leave a
  // dangling tail.
  if (extraValues) {
    const vals = Array.from(new Set(Array.from(extraValues)))
      .filter(v => typeof v === 'string' && v.trim().length >= 6)
      .sort((a, b) => b.length - a.length);
    for (const v of vals) {
      out = out.replace(new RegExp(escapeRegExp(v), 'g'), REDACTED);
    }
  }

  // Layer 1: known token patterns, then the generic fallback.
  for (const re of TOKEN_PATTERNS) {
    // Reset lastIndex defensively (these are module-level /g regexes).
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  out = scrubGenericBlobs(out);

  return out;
}

/** Deep-scrub a JSON-ish value: walks strings inside objects/arrays and
 *  scrubs each. Used where an event carries structured `input` (e.g. a
 *  tool-use Bash command) rather than a flat string. Returns a NEW value;
 *  the input is not mutated. Non-container, non-string values pass through. */
export function scrubDeep(value: unknown, extraValues?: Iterable<string>): unknown {
  if (typeof value === 'string') return scrubSecrets(value, extraValues);
  if (Array.isArray(value)) return value.map(v => scrubDeep(v, extraValues));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubDeep(v, extraValues);
    }
    return out;
  }
  return value;
}

/**
 * Per-event redaction. Returns the event unchanged when it carries no free
 * text; otherwise a shallow copy with the text field(s) scrubbed.
 *
 * ── Why this lives here and not beside the executor pipeline ─────────────
 * `run-runner.ts` described `scrubEventStream` as "the single chokepoint
 * every event passes through before the run-controller persists + broadcasts
 * it, so it's the 'scrub before appendEvent' hook the security invariant
 * requires". It was not a chokepoint: four route handlers called
 * `store.appendEvent` directly and went around it — `signal-received.payload`
 * (the raw POST body, arbitrary external input), `gate-decision.message`
 * (human-entered), `phase-user-message.text` (A2A follow-up) and the
 * `run-cancelled` sentinel. The invariant was asserted in a comment and
 * enforced by nothing, which is the anti-pattern this project's own docs name
 * as its dominant bug class.
 *
 * Moving it next to `scrubSecrets` makes it importable from the routes, so
 * there is one redaction function rather than a privileged path and four
 * unprivileged ones.
 *
 * `secrets` is the run's live injected-secret set when the caller has one
 * (the executor pipeline does). Route-level callers pass nothing and still
 * get the pattern-based redaction, which is what catches a provider token
 * pasted into a webhook payload or a gate message.
 */
export function scrubEvent<T>(ev: T, secrets?: Iterable<string>): T {
  const e = ev as Record<string, unknown> & { type?: string };
  switch (e.type) {
    case 'phase-delta':
    case 'phase-user-message':
      return { ...ev, text: scrubSecrets(String(e.text ?? ''), secrets) };
    case 'phase-end':
    case 'phase-tool-result':
      return { ...ev, output: scrubSecrets(String(e.output ?? ''), secrets) };
    case 'artifact':
      return {
        ...ev,
        content: scrubSecrets(String(e.content ?? ''), secrets),
        mediaType: scrubSecrets(String(e.mediaType ?? ''), secrets),
      };

    case 'run-error':
    case 'phase-error':
    case 'node-retried':
    case 'node-recovered':
      return { ...ev, error: scrubSecrets(String(e.error ?? ''), secrets) };
    // Human- and sender-supplied free text that reaches the durable log
    // through a ROUTE rather than the executor. `decidedBy` is an identity,
    // not free text, and is deliberately left alone.
    case 'gate-decision':
      return e.message != null
        ? { ...ev, message: scrubSecrets(String(e.message), secrets) }
        : ev;
    case 'signal-received':
      return e.payload != null
        ? { ...ev, payload: scrubSecrets(String(e.payload), secrets) }
        : ev;
    // EVERY variant carrying a `reason`, with no carve-outs.
    //
    // `phase-terminal.reason` is free text built from the agent's own
    // terminal-failure marker and was NOT scrubbed — a real leak path found by
    // the coverage test in `scrub-coverage.test.ts`, not by reading this
    // switch. `phase-paused.reason` is a genuine enum ('user' | 'max-turns')
    // and was deliberately excluded as a micro-optimisation; scrubbing an enum
    // is a no-op, and the carve-out was one more exception to remember. The
    // rule is now simply "a `reason` gets scrubbed".
    case 'run-interrupted':
    case 'budget-halted':
    case 'loop-stopped':
    case 'lifecycle-warning':
    case 'phase-skipped':
    case 'phase-terminal':
    case 'phase-paused':
      return e.reason != null
        ? { ...ev, reason: scrubSecrets(String(e.reason), secrets) }
        : ev;
    case 'phase-tool-use':
      // `input` is the tool's arguments (e.g. a Bash command) — deep-scrub
      // so a secret echoed in a command string never lands in the log.
      return { ...ev, input: scrubDeep(e.input, secrets) };
    default:
      return ev;
  }
}
