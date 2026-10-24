/**
 * `${var}` substitution against a state map.
 *
 * Replaces `${name}` and `${a.b.c}` with values from `state`. Dot paths into
 * objects/arrays are supported. Reserved keys (set by the executor at the
 * relevant scope):
 *   - `input`         — the current input string (predecessor's output)
 *   - `item`, `index` — inside a `map` body, the current array element / position
 *   - `error.message` — inside an `onError` recovery branch, the failure msg
 *
 * Unknown references render literally (the original `${...}` is left in place)
 * so failures are visible rather than silent.
 */

import { SECRET_NAME_SHAPE } from '../server/scrub-secrets';

export type State = Record<string, unknown>;

const REF = /\$\{([^}]+)\}/g;

export function interpolate(
  template: string,
  state: State,
  onUnresolved?: (ref: string) => void,
  onEmpty?: (ref: string) => void,
): string {
  if (!template || !template.includes('${')) return template;
  return template.replace(REF, (whole, expr) => {
    const ref = String(expr).trim();
    const value = lookup(state, ref);
    if (value === undefined) {
      // Leave the literal in place — some flows rely on an un-substituted
      // `${...}` degrading gracefully downstream (e.g. a default-bearing CLI
      // arg). But SIGNAL it so the executor can surface a visible
      // "unresolved interpolation ref" warning, instead of the miss hiding as a
      // stray literal in the output (the silent failure that produced a literal
      // `${releaseReport}` in a QA report).
      onUnresolved?.(ref);
      return whole;
    }
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    // A ref that RESOLVES but to an empty/whitespace value is a distinct
    // failure mode from an unresolved one: the binding exists (an upstream `as`
    // wrote it) but produced nothing — e.g. an agent that truncated on the token
    // ceiling before emitting its summary line. Interpolating "" is silent, so a
    // downstream report phase looks identical to success. SIGNAL it so the
    // executor can flag the empty binding (see `binding-empty`). The caller
    // decides which refs matter (only `as`-produced bases), so this fires for
    // EVERY empty resolution and the executor filters.
    if (onEmpty && rendered.trim() === '') onEmpty(ref);
    return rendered;
  });
}

/** Resolve one dotted reference against state — the lookup `interpolate`
 *  uses, exposed for callers that need the VALUE (an object, a number) rather
 *  than its rendering into a string. `undefined` when it does not resolve. */
export function resolveRef(state: State, path: string): unknown {
  return lookup(state, path.trim());
}

function lookup(state: State, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = state;
  for (const part of parts) {
    // `as`-bound agent/code outputs are stored as raw strings. When a deeper
    // field is requested (`${login.ready}`), transparently JSON-parse a string
    // that looks like an object/array so the dotted path resolves into it
    // instead of dead-ending to `undefined` and rendering the literal `${...}`.
    if (typeof cur === 'string') {
      const t = cur.trim();
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try {
          cur = JSON.parse(t);
        } catch {
          return undefined;
        }
      }
    }
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Resolve an `over` field for a `map` node. Accepts:
 *   - `${name}` → look up in state; must resolve to an array (or JSON-encoded array string)
 *   - inline JSON array literal (starts with `[`)
 * Throws with a clear message if it can't resolve to an array.
 */
export function resolveOver(over: string, state: State): unknown[] {
  const trimmed = over.trim();
  if (trimmed.startsWith('[')) {
    return parseArray(trimmed, `inline "over" value`);
  }
  const m = trimmed.match(/^\$\{([^}]+)\}$/);
  if (m) {
    const refName = m[1].trim();
    const value = lookup(state, refName);
    if (value === undefined) {
      throw new Error(
        `map "over" reference ${over} is undefined — make sure a previous node sets it via "as" or pass it as initialInput`,
      );
    }
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return parseArray(value, `state "${refName}"`);
    throw new Error(`map "over" reference ${over} resolved to non-array (${typeof value})`);
  }
  // Substitute then parse — useful for `${docs}` embedded in a literal.
  const substituted = interpolate(over, state);
  return parseArray(substituted, `interpolated "over" value`);
}

function parseArray(raw: string, source: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`${source} parsed but is not an array`);
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `map "over" couldn't parse as JSON array (${source}): ${(err as Error).message}`,
    );
  }
}

/** Evaluate a `when` predicate. Falsy = skip the node. Same rules as JS
 * truthiness with explicit string handling: "", "false", "0", "null",
 * "undefined" are all falsy.
 *
 * `onUnresolved` (threaded to `interpolate`) fires for every `${ref}` that
 * doesn't resolve against `state`. This matters MORE for `when` than anywhere
 * else: an unresolved ref stays a literal `${...}` — a non-empty string — so
 * without the hook a `when: "${flagNobodySets}"` silently evaluated TRUTHY and
 * the guarded node always ran. The executor now collects these and treats an
 * unresolved predicate as a loud fail-safe SKIP instead (see executeNode);
 * callers that don't pass the hook keep the raw literal-is-truthy result. */
export function whenTruthy(
  predicate: string,
  state: State,
  onUnresolved?: (ref: string) => void,
): boolean {
  const resolved = interpolate(predicate, state, onUnresolved)
    .trim()
    .toLowerCase();
  if (!resolved) return false;
  if (['false', '0', 'null', 'undefined', 'no'].includes(resolved)) return false;
  return true;
}

/**
 * `${connections:<name>}` / `${connections:<name>.<field>}` substitution.
 *
 * Used in places where a literal secret would otherwise be hardcoded
 * (mcp/servers.json env block, a2a URLs, sandbox tool env). Reads from
 * a connections map shaped `{ <name>: { value, url, fields?, ... } }`
 * — the same shape `readCredentialsByNameRaw` returns. Default field
 * is `value`; dotted paths resolve `fields.<key>` and any other
 * top-level field on the Credential entry.
 *
 * Unknown references render literally (same rule as `interpolate`) so
 * a misspelled connection name shows up as a visible failure instead
 * of a silently-empty env var, which used to mean MCP subprocesses
 * would start with no token and fail in confusing ways downstream.
 *
 * The connections map shape (deliberately loose):
 *   Record<string, { value?: string; url?: string;
 *                    fields?: Record<string,string>;
 *                    [k:string]: unknown }>
 */
export type ConnectionEntry = {
  value?: string;
  url?: string;
  fields?: Record<string, string>;
  [key: string]: unknown;
};
export type ConnectionsMap = Record<string, ConnectionEntry>;

const CONN_REF = /\$\{connections:([^}]+)\}/g;

export function resolveConnectionRefs(
  template: string,
  connections: ConnectionsMap,
): string {
  if (!template || !template.includes('${connections:')) return template;
  return template.replace(CONN_REF, (whole, exprRaw) => {
    const expr = String(exprRaw).trim();
    const dot = expr.indexOf('.');
    const name = dot === -1 ? expr : expr.slice(0, dot);
    const fieldPath = dot === -1 ? 'value' : expr.slice(dot + 1);
    const entry = connections[name];
    if (!entry) return whole;
    const value = lookupConnectionField(entry, fieldPath);
    if (value === undefined) return whole;
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

function lookupConnectionField(
  entry: ConnectionEntry,
  fieldPath: string,
): unknown {
  if (!fieldPath) return entry.value;
  const parts = fieldPath.split('.');
  let cur: unknown = entry;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Recursively walk a JSON-shaped object and apply
 *  `resolveConnectionRefs` to every string leaf. Used to rewrite
 *  `mcp/servers.json` entries (`env` block strings, `command`, `url`,
 *  `headers`) before handing them to the SDK / spawning the
 *  subprocess. Returns a new object — the input is untouched. */
export function resolveConnectionRefsDeep<T>(
  value: T,
  connections: ConnectionsMap,
): T {
  if (typeof value === 'string') {
    return resolveConnectionRefs(value, connections) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map(v => resolveConnectionRefsDeep(v, connections)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveConnectionRefsDeep(v, connections);
    }
    return out as unknown as T;
  }
  return value;
}

/** An argv element that names its own credential (`--token=…`,
 *  `--client_secret=…`). The trailing boundary keeps `--keyfile=` /
 *  `--secrets-dir=` — a location, not a secret — out. */
const SECRET_ARGV_FLAG = /^--?[\w-]*(key|token|secret|password|passwd)\b/i;

/** Does this VALUE carry a credential whatever its key is called? The two
 *  shapes the log scrubber's pattern pass cannot see: a URL with userinfo
 *  (`postgres://user:pw@db/app`, `https://ghp_…@github.com/…`) and an argv
 *  element that names its own secret. Both are masked on GET, so a value the
 *  credentials surface holds back from the operator must not reach a run's
 *  durable events either.
 *
 *  This DUPLICATES two clauses of `isSecretLookingLeaf`, the predicate the
 *  masker and the PUT reconciler share, because that predicate is
 *  module-private to `src/server/credentials-store.ts`. The two copies must
 *  stay in step: a clause added there belongs here too, or a shape the
 *  credentials surface masks starts reaching the event log. Its third shape
 *  clause — a value `looksLikeKnownToken` recognises — is deliberately NOT
 *  duplicated: the scrubber's pattern pass already redacts those, and
 *  mirroring it here would exact-redact every long ordinary URL an agent
 *  echoes. */
function valueCarriesCredential(value: string): boolean {
  if (SECRET_ARGV_FLAG.test(value) && value.includes('=')) return true;
  if (!value.includes('@') || !value.includes('://')) return false;
  try {
    const u = new URL(value);
    return u.username !== '' || u.password !== '';
  } catch {
    return false;
  }
}

/** Is a `${connections:<name>.<field>}` field path secret-bearing?
 *  The default field (`value`) is always the credential secret; `env.*`
 *  (an MCP env block, which holds tokens) and `cache.*` (cached OAuth /
 *  SSO access tokens) are too. `url` is not, so it is left out to avoid
 *  over-redacting ordinary values an agent legitimately echoes (a base URL)
 *  from run output.
 *
 *  `fields.*` is non-secret BY CONVENTION (site URL, email, workspace slug)
 *  but free-form, and the credentials surface now MASKS a secret-looking
 *  `fields` key on GET. A prefix rule that rejected the whole block therefore
 *  disagreed with the masker: a `${connections:x.fields.apiToken}` injected
 *  into an MCP server's env was a secret to GET and not to the scrubber, so
 *  it never reached the run's `injectedSecrets` sink. Decide per KEY with the
 *  masker's own vocabulary (`SECRET_NAME_SHAPE`, the one the log scrubber
 *  shares) so `fields.site` stays readable while `fields.apiToken` is
 *  registered — and per VALUE for the two credential-bearing SHAPES the
 *  pattern pass cannot see, since a DSN or a `--password=…` filed under an
 *  innocuous key is masked on GET while matching no token pattern, so
 *  deciding by name alone left it the one secret with no backstop anywhere.
 *  `resolved` is therefore the value the ref resolves to, read before the
 *  decision rather than after it.
 *
 *  `headers.*` is all credential material (the masker treats every header
 *  value as secret) and is an injection site named in
 *  `collectConnectionSecretsDeep`'s own header, so it counts outright. */
function isSecretConnectionField(fieldPath: string, resolved?: unknown): boolean {
  if (!fieldPath || fieldPath === 'value') return true;
  if (fieldPath.startsWith('env.') || fieldPath.startsWith('cache.')) {
    return true;
  }
  if (fieldPath.startsWith('headers.')) return true;
  if (fieldPath.startsWith('fields.')) {
    return (
      SECRET_NAME_SHAPE.test(fieldPath.slice('fields.'.length)) ||
      (typeof resolved === 'string' && valueCarriesCredential(resolved))
    );
  }
  return false;
}

/**
 * Harvest the SECRET literal values a config's `${connections:...}` refs
 * resolve to, so they can be registered for run-wide output scrubbing.
 *
 * SECURITY (MCP residual-leak closure): `resolveConnectionRefsDeep`
 * injects real secrets into an MCP server's `env` / `headers` / `url`
 * before the subprocess is spawned. Those secrets never touch the prompt
 * or event log directly — but an MCP subprocess can ECHO one back into a
 * tool result (a verbose curl, a stack trace). Unless the value is in the
 * run's `injectedSecrets` sink, the scrubber only catches it if it
 * happens to match a known token pattern. This walks the RAW config,
 * resolves only the secret-bearing refs (see `isSecretConnectionField`),
 * and returns the resolved non-empty strings — the caller adds them to
 * `injectedSecrets` so the central scrub chokepoint redacts them.
 *
 * Pure: reads `connections`, mutates nothing. Short values ( < 6 chars)
 * are dropped — the scrubber ignores them anyway, and redacting a 1-2
 * char string would mangle ordinary output.
 */
export function collectConnectionSecretsDeep(
  value: unknown,
  connections: ConnectionsMap,
  out: Set<string> = new Set<string>(),
): Set<string> {
  if (typeof value === 'string') {
    if (!value.includes('${connections:')) return out;
    // Reuse the same matcher resolveConnectionRefs uses, but only keep
    // the secret-bearing fields' resolved values.
    const re = new RegExp(CONN_REF.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) {
      const expr = String(m[1]).trim();
      const dot = expr.indexOf('.');
      const name = dot === -1 ? expr : expr.slice(0, dot);
      const fieldPath = dot === -1 ? 'value' : expr.slice(dot + 1);
      const entry = connections[name];
      if (!entry) continue;
      const resolved = lookupConnectionField(entry, fieldPath);
      if (!isSecretConnectionField(fieldPath, resolved)) continue;
      if (typeof resolved === 'string' && resolved.trim().length >= 6) {
        out.add(resolved);
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectConnectionSecretsDeep(v, connections, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectConnectionSecretsDeep(v, connections, out);
    }
  }
  return out;
}
