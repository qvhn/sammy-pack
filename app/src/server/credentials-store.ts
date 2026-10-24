/**
 * Credentials registry — a named-entries store for secrets that
 * orchestrations + the server reference at run time. Foundation for
 * future per-orchestration credential references; today it serves as
 * a fallback for the provider-key resolution chain (env var first,
 * then credentials.json by canonical name).
 *
 * Lives in `<repoRoot>/credentials.json` by default; can be relocated
 * via `SAMMY_CONNECTIONS_FILE` env var or `--connections <path>` CLI
 * flag (see sammyPackApiPlugin). JSON map of
 * `{ "<name>": { value: "<secret>", description?: "..." } }` — named
 * entries an orchestration references by string id.
 *
 * **Kind discriminator**: entries default to `kind: "secret"` (the
 * original shape). Newer entries may declare `kind` (atlassian /
 * github / aws / mcp-server / a2a / etc.) plus kind-specific fields
 * (`authMethod`, `fields`, `url`, `expiresAt`, `refresh`, AWS SSO
 * fields, etc.). Back-compat is total — existing pre-`kind` entries
 * continue to parse + resolve unchanged.
 *
 * Module is server-only.
 */

import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SECRET_NAME_SHAPE, looksLikeKnownToken } from './scrub-secrets';

export type CredentialKind =
  | 'secret'
  | 'api-key'
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'atlassian'
  | 'jira'
  | 'github'
  | 'bitbucket'
  | 'gitlab'
  | 'linear'
  | 'figma'
  | 'notion'
  | 'slack'
  | 'aws'
  | 'mcp-server'
  | 'a2a';

export type CredentialAuthMethod =
  | 'api-token'
  | 'api-key'
  | 'bearer'
  | 'basic'
  | 'oauth-code'
  | 'oauth-pkce'
  | 'device-flow'
  | 'sso'
  | 'iam-role'
  | 'none';

export type Credential = {
  value: string;
  description?: string;
  /** Per-credential scoping (optional, additive). When set, only runs
   *  whose owner matches one of these IDs can resolve this credential.
   *  Empty/missing = unrestricted (back-compat default — every
   *  pre-existing entry stays usable by everyone). */
  owners?: string[];
  /** Per-credential orchestration allowlist (optional, additive). When
   *  set, only the listed orchestration names can reference this
   *  credential. Empty/missing = unrestricted. */
  orchestrations?: string[];
  // ─── kind-tagged extensions (all optional; absent = legacy "secret") ───
  /** Discriminator. When absent, treated as `secret`. */
  kind?: CredentialKind;
  /** Auth method appropriate for the kind (api-token / oauth-pkce /
   *  sso / device-flow / ...). Documentation hint only — the executor
   *  consumes `value` regardless. */
  authMethod?: CredentialAuthMethod;
  /** Non-secret fields (site URL, email, workspace slug, base URL,
   *  Slack team id, etc.). Same keys as the legacy
   *  `sammy.connection.<type>.<field>` localStorage entries. */
  fields?: Record<string, string>;
  /** ISO-8601 expiry for short-lived tokens (device-flow, OAuth). */
  expiresAt?: string;
  /** Refresh hint for tokens that can be refreshed automatically. */
  refresh?: {
    via: 'github-device' | 'oauth-pkce' | 'aws-sso' | string;
    scope?: string;
  };
  /** For `kind: a2a` and `kind: mcp-server` (http/sse transport) — the
   *  endpoint URL. Lets orchestrations reference connections by name
   *  instead of pasting literal URLs. */
  url?: string;
  /** For `kind: mcp-server` — name of the `mcp/servers.json` entry
   *  whose env block this credential supplies. Optional pointer used
   *  by the Connections UI to keep the two files in sync. */
  ref?: string;
  /** For `kind: mcp-server` — env vars that should be merged into the
   *  MCP subprocess's environment. Values may use
   *  `${connections:<other>.value}` to chain to another entry. */
  env?: Record<string, string>;
  // ─── AWS SSO-specific (kind: aws, authMethod: sso) ───
  ssoStartUrl?: string;
  ssoRegion?: string;
  accountId?: string;
  roleName?: string;
  /** Cached SSO access token + role credentials. Refreshed on demand
   *  when `expiresAt < now`. */
  cache?: {
    accessToken?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    expiresAt?: string;
  };
};

export type CredentialsConfig = Record<string, Credential>;

/** What a value too short to mask meaningfully (under `MASK_MIN_LENGTH`
 *  chars) is shown as. A prefix+suffix of such a value would reveal most of
 *  it, and the empty string it collapsed to before was indistinguishable
 *  from "not set": a non-secret short `env` value (`AWS_REGION=us-west-2`)
 *  rendered blank in the editor. A fixed, obviously synthetic token says
 *  "there is a value here and you may not see it"; `isMaskOf` recognises
 *  it, so a PUT that echoes it restores the stored value like any other
 *  mask. */
export const SHORT_VALUE_MASK = '••••••••';

/** The mask reveals at most this fraction of a value: one character in
 *  four. Below `MASK_MIN_LENGTH` that budget holds nothing recognisable, so
 *  the placeholder is shown instead. */
const MASK_REVEAL_DIVISOR = 4;
const MASK_MIN_LENGTH = 16;
/** The recognisable shape for a real API token: up to 6 leading chars (the
 *  provider prefix — `ATATT3`, `ghp_01`, `sk-ant`) and the last 2. */
const MASK_MAX_HEAD = 6;
const MASK_TAIL = 2;

/** Mask a secret for display. Shows a prefix + the last 2 characters
 *  joined by an ellipsis (e.g. `ATATT3…28`) so an operator can still
 *  recognize WHICH secret an entry holds without exposing it. The reveal
 *  is bounded to a QUARTER of the value and never more than 6+2: a 32+
 *  char API token keeps the full recognisable shape, a 16–31 char value
 *  shows 2–5 + 2, and anything shorter becomes `SHORT_VALUE_MASK`, never
 *  the empty string. An empty / missing value stays empty.
 *
 *  It was an unconditional first6+last2 above 8 chars, which disclosed 8
 *  of a 9-char password and 8 of a 12-char one — "mostly revealed", not
 *  masked — for exactly the human-length values the `env` / argv surfaces
 *  carry (a `DB_PASSWORD`, a `--password` arg). Human-length values show
 *  nothing; only provider tokens, which are long and prefix-recognisable
 *  by design, show their prefix.
 *
 *  SECURITY: this is the ONLY representation of a secret value that may
 *  leave the server via the credentials LIST/GET API. The raw value is
 *  never returned by that endpoint (see the GET handler).
 *
 *  Measured and cut in CODE POINTS, not UTF-16 code units: slicing a
 *  non-ASCII secret by code unit cut a surrogate pair in half, so GET
 *  shipped an ill-formed string, and anything on the round trip that
 *  replaced the lone surrogate with U+FFFD made the echo unrecognisable to
 *  `isMaskOf` — which writes the placeholder over the real secret. Identical
 *  for ASCII, where the two lengths are the same. */
export function maskSecret(value: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  const chars = Array.from(value);
  if (chars.length < MASK_MIN_LENGTH) return SHORT_VALUE_MASK;
  const budget = Math.floor(chars.length / MASK_REVEAL_DIVISOR);
  const head = Math.min(MASK_MAX_HEAD, budget - MASK_TAIL);
  return `${chars.slice(0, head).join('')}…${chars.slice(-MASK_TAIL).join('')}`;
}

/** The shape `maskSecret` produced before the reveal was bounded (first 6 +
 *  last 2 of anything over 8 chars). A client that loaded the registry
 *  under that shape and saves after an upgrade echoes it; refusing to
 *  recognise it would write the literal mask into the file as the new
 *  secret. Recognising it is safe — no real secret is a 9-char string with
 *  an ellipsis in it — and it can go once no such client can exist. */
function legacyMaskOf(stored: string): string {
  if (stored.length <= 8) return SHORT_VALUE_MASK;
  return `${stored.slice(0, 6)}…${stored.slice(-2)}`;
}

/** Whether `candidate` is the masked form of `stored` (i.e. the client
 *  sent back the value we masked, untouched). Used by the PUT
 *  reconciliation so re-saving an entry the user never re-typed doesn't
 *  overwrite the real secret with its mask. */
export function isMaskOf(candidate: string, stored: string): boolean {
  if (!candidate) return false;
  return candidate === maskSecret(stored) || candidate === legacyMaskOf(stored);
}

/** The `cache` members that are credentials in their own right (an SSO
 *  access token and the role credentials it minted). `expiresAt` is a
 *  timestamp and stays readable so the UI can show when a refresh is due. */
const CACHE_SECRET_KEYS = [
  'accessToken',
  'accessKeyId',
  'secretAccessKey',
  'sessionToken',
] as const;

/** Mask a string map in place-of (a copy): every value → its mask. */
function maskStringMap(
  map: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = maskSecret(typeof v === 'string' ? v : undefined);
  }
  return out;
}

/** A Credential with EVERY secret-bearing field masked — the ONLY shape of
 *  an entry that may leave the server through a list surface (GET / PUT
 *  echo / import preview).
 *
 *  `value` was the only field the list endpoint masked, which treated it
 *  as the entry's one secret. It is not: an `mcp-server` entry carries the
 *  provider keys for its subprocess in `env`, an `aws` SSO entry caches an
 *  access token plus a full set of role credentials in `cache`, and an
 *  entry may carry request `headers`. Those went out verbatim under a
 *  comment claiming the raw value "never leaves the server". One helper,
 *  used at every site, so a new secret-bearing field has one place to be
 *  added rather than three places to be forgotten.
 *
 *  Non-secret metadata (kind, url, owners, orchestrations, description,
 *  expiresAt) is passed through untouched — it is what an operator needs
 *  to recognise and edit an entry. `fields` is non-secret BY DESIGN (site
 *  URL, email, region) but free-form: a hand-written entry may put a
 *  `password` or `apiToken` there, and the MCP registry masker would mask
 *  that same key anywhere in its tree while this one echoed it verbatim.
 *  The shared predicate decides per key, so an email stays readable. */
export function maskCredentialEntry(entry: Credential | undefined): Credential {
  const e = (entry && typeof entry === 'object' ? entry : {}) as Credential;
  const out: Credential = { ...e, value: maskSecret(e.value) };
  if (e.env && typeof e.env === 'object' && !Array.isArray(e.env)) {
    out.env = maskStringMap(e.env);
  }
  if (e.fields && typeof e.fields === 'object' && !Array.isArray(e.fields)) {
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(e.fields)) {
      fields[k] = typeof v === 'string' && isSecretLookingLeaf(k, v) ? maskSecret(v) : v;
    }
    out.fields = fields;
  }
  if (e.cache && typeof e.cache === 'object' && !Array.isArray(e.cache)) {
    const cache: NonNullable<Credential['cache']> = { ...e.cache };
    for (const k of CACHE_SECRET_KEYS) {
      if (typeof cache[k] === 'string') cache[k] = maskSecret(cache[k]);
    }
    out.cache = cache;
  }
  // Not part of the typed shape, but an entry written by hand (or by an
  // older importer) may carry request headers; treat every value as secret.
  const headers = (e as { headers?: unknown }).headers;
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    (out as { headers?: Record<string, string> }).headers = maskStringMap(
      headers as Record<string, unknown>,
    );
  }
  return out;
}

/** Is this entry visible to `ownerId` on a LIST / WRITE surface? Mirrors
 *  the `owners` rule the run-time resolver (`readCredentialsByNameRaw`)
 *  applies: no `owners` = unrestricted (the back-compat default), otherwise
 *  the caller must be listed. The `orchestrations` allowlist is NOT a
 *  visibility rule — it scopes which runs may *resolve* the secret, and an
 *  operator editing the registry is not a run. */
export function credentialVisibleTo(
  entry: Credential | undefined,
  ownerId: string,
): boolean {
  if (!entry || typeof entry !== 'object') return false;
  if (!Array.isArray(entry.owners) || entry.owners.length === 0) return true;
  return entry.owners.includes(ownerId);
}

/** An argv element that names a credential flag: `--token`, `--api-key`,
 *  `-password`, `--client_secret=…`. The word may be hyphenated (`api-key`),
 *  so the run before the secret word admits `-`; the trailing boundary keeps
 *  `--keyfile` / `--secrets-dir` (a location, not a secret) out. */
const SECRET_FLAG_RE = /^--?[\w-]*(key|token|secret|password|passwd)\b/i;

/** `scheme://user:pass@host/…` — a URL that carries credentials. Any
 *  userinfo counts: a GitHub remote puts the token in the USERNAME slot
 *  (`https://ghp_…@github.com/…`). Masking the whole URL is right — it is
 *  useless to an operator without the credential anyway. */
function hasUrlUserinfo(value: string): boolean {
  if (!value.includes('@') || !value.includes('://')) return false;
  try {
    const u = new URL(value);
    return u.username !== '' || u.password !== '';
  } catch {
    return false;
  }
}

/** `scheme://host/path?token=…` — a URL whose QUERY carries the credential.
 *  The sibling of `hasUrlUserinfo`, and the other half of the shape the
 *  polling-trigger listing's masker exists for: a feed key is typically a
 *  32-char opaque blob, which no provider pattern recognises and which the
 *  generic 40+ entropy run does not reach, so by VALUE it is invisible. It is
 *  the parameter NAME that says what it is — judged with `SECRET_NAME_SHAPE`,
 *  the vocabulary every other surface here shares, so `?page=2` stays
 *  readable. An empty value is a parameter with no secret in it. */
function hasSecretQueryParam(value: string): boolean {
  if (!value.includes('?') || !value.includes('://')) return false;
  try {
    for (const [k, v] of new URL(value).searchParams) {
      if (v !== '' && SECRET_NAME_SHAPE.test(k)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** The two shapes the by-shape rule must leave readable — an MCP server's
 *  own LOCATION: a filesystem path (absolute, drive-lettered, `./`, `../`,
 *  `~/`) or a scoped package spec (`@scope/server-…`). Both are 40+ char
 *  runs the generic high-entropy pattern matches, and masking them blinds
 *  the operator to the one value they must be able to read.
 *
 *  The carve-out was `value.includes('/')`, which also exempted every shape
 *  the scrubber DOES recognise that happens to carry a slash — an AWS secret
 *  access key (base64 alphabet), a webhook URL whose path IS the credential
 *  — so those left GET /api/mcp-servers verbatim under a non-secret key. A
 *  location starts like one; a secret does not. */
const LOCATION_SHAPE_RE = /^(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/]|~[\\/]|@[\w.-]+\/)/;

/** Does a string at key `key` with value `value` count as secret-bearing in
 *  a free-form config? THE one predicate both the masker and the reconciler
 *  consult, so GET and PUT agree about what a client could not have
 *  re-typed. `prev` is the element before `value` when it sits in an array,
 *  undefined otherwise.
 *
 *  By NAME: the key matches `SECRET_NAME_SHAPE` (the vocabulary shared with
 *  the log scrubber), or the value is a `${connections:…}` reference (it
 *  names a registry entry and resolves to one at run time, so it is treated
 *  as the secret it stands for).
 *
 *  By SHAPE — the name rule alone was not enough. Array elements inherit the
 *  parent key (`args`), so an MCP stdio server's positional credential went
 *  out verbatim: `['--api-key', 'ghp_…']`, `['--token=sk-ant-…']`, or a
 *  connection URL with a password in it — which is exactly what the UI's own
 *  Postgres template writes. Three shapes:
 *    (a) a URL that CARRIES a credential — in its userinfo
 *        (`https://user:token@host/…`) or in a query parameter the shared
 *        vocabulary names (`?token=…`). Both spellings, because both are
 *        what a polling trigger's `source` comes in as;
 *    (b) a value the log scrubber would redact (`looksLikeKnownToken`, the
 *        same pattern list — never a second one), unless it is a location
 *        (`LOCATION_SHAPE_RE`). A plain URL with a 40+ char path run is
 *        masked too — over-masking it costs the operator a re-type, while
 *        exempting URLs would hand back the webhook whose path is the
 *        secret; a URL with credentials is caught by (a) regardless;
 *    (c) argv: `--token=value` masks itself (the flag name is part of the
 *        element), and a bare `--token` / `--api-key` marks the NEXT element
 *        as the secret. */
function isSecretLookingLeaf(
  key: string | undefined,
  value: string,
  prev?: unknown,
): boolean {
  return (
    (key !== undefined && SECRET_NAME_SHAPE.test(key)) ||
    value.includes('${connections:') ||
    hasUrlUserinfo(value) ||
    hasSecretQueryParam(value) ||
    (!LOCATION_SHAPE_RE.test(value) && looksLikeKnownToken(value)) ||
    (SECRET_FLAG_RE.test(value) && value.includes('=')) ||
    (typeof prev === 'string' && SECRET_FLAG_RE.test(prev) && !prev.includes('='))
  );
}

/** Deep-mask a free-form JSON config (the MCP server registry): every
 *  string `isSecretLookingLeaf` accepts — by key, by `${connections:…}` ref,
 *  or by its own shape — becomes its `maskSecret` form. Structure,
 *  non-secret strings, numbers and booleans pass through unchanged; the
 *  input is not mutated. `prev` is the preceding array element (the argv
 *  rule); callers never pass it.
 *
 *  `GET /api/mcp-servers` returned the registry verbatim — env blocks with
 *  provider keys, `Authorization` headers — on the reasoning that the dev
 *  server is localhost-only. The same server is also the documented shared
 *  deployment, where that route is a one-GET dump of every MCP secret. */
export function maskSecretsDeep(
  value: unknown,
  key?: string,
  prev?: unknown,
): unknown {
  if (typeof value === 'string') {
    return isSecretLookingLeaf(key, value, prev) ? maskSecret(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => maskSecretsDeep(v, key, value[i - 1]));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskSecretsDeep(v, k);
    }
    return out;
  }
  return value;
}

/** The write-side twin of `maskSecretsDeep`: walk `incoming` alongside the
 *  on-disk `stored` config and put back every secret-looking leaf the
 *  client could only have echoed (its value is the mask of the stored one,
 *  or empty while a stored value exists). Anything else the client sent is
 *  taken as-is. Same contract as `reconcileMaskedEntry`, for a free-form
 *  tree — without it the UI's GET → edit → PUT-the-whole-registry round
 *  trip would write masks into `mcp/servers.json`. The leaf decision is
 *  made on the STORED value and its STORED predecessor, because that is
 *  what the mask the client echoes was computed from. */
export function reconcileMaskedDeep(
  incoming: unknown,
  stored: unknown,
  key?: string,
  prev?: unknown,
): unknown {
  if (typeof incoming === 'string') {
    if (typeof stored !== 'string' || stored === '') return incoming;
    if (!isSecretLookingLeaf(key, stored, prev)) return incoming;
    return incoming === '' || isMaskOf(incoming, stored) ? stored : incoming;
  }
  if (Array.isArray(incoming)) {
    const storedArr = Array.isArray(stored) ? stored : [];
    return incoming.map((v, i) =>
      reconcileMaskedDeep(v, storedArr[i], key, storedArr[i - 1]),
    );
  }
  if (incoming && typeof incoming === 'object') {
    const storedObj =
      stored && typeof stored === 'object' && !Array.isArray(stored)
        ? (stored as Record<string, unknown>)
        : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
      out[k] = reconcileMaskedDeep(v, storedObj[k], k);
    }
    return out;
  }
  return incoming;
}

/** Restore ONE secret string: the stored value when the client echoed its
 *  mask or sent empty while a real secret exists; otherwise the incoming
 *  value untouched. Returns whether a restore happened. */
function restoreMasked(
  incoming: unknown,
  stored: unknown,
): { value: string; restored: boolean } {
  const storedValue = typeof stored === 'string' ? stored : '';
  const incomingValue = typeof incoming === 'string' ? incoming : '';
  if (
    storedValue &&
    (incomingValue === '' || isMaskOf(incomingValue, storedValue))
  ) {
    return { value: storedValue, restored: true };
  }
  return { value: incomingValue, restored: false };
}

/** Per-entry reconciliation, covering EVERY field `maskCredentialEntry`
 *  masks (`value`, `env.*`, `cache.*`, `headers.*`, the secret-looking
 *  `fields.*`) — the list surface and the write surface must agree on what
 *  a client could not have re-typed, or a round-trip corrupts whatever one
 *  masks and the other doesn't.
 *
 *  The Connections UI pre-fills its edit form with whatever GET returned
 *  and sends the WHOLE map back on save (PUT is a full replace); the PUT
 *  handler runs this per entry. A secret is restored whenever the incoming
 *  value is EITHER the exact mask of the stored value OR empty while a
 *  non-empty value exists on disk. A value the user genuinely changed
 *  (anything else) is taken as-is. A genuinely empty value for an entry
 *  that never had one (mcp-server / aws-sso with no `value`) stays empty.
 *  Pure — does not read or write the file; the caller supplies `prior`.
 *
 *  `restored` is true when at least one secret came from disk rather than
 *  the request, i.e. the caller is saving this entry WITHOUT having
 *  supplied its secret. The PUT handler uses that to refuse moving the
 *  entry's destination (`url` / `fields`) or audience (`owners` /
 *  `orchestrations`): a caller who never saw a secret must not be able to
 *  point it somewhere new and have the server deliver it there. */
export function reconcileMaskedEntry(
  incoming: Credential,
  prior: Credential | undefined,
): { entry: Credential; restored: boolean } {
  if (!incoming || typeof incoming !== 'object') {
    return { entry: incoming, restored: false };
  }
  if (!prior || typeof prior !== 'object') {
    return { entry: incoming, restored: false };
  }
  let restored = false;
  const out: Credential = { ...incoming };
  const value = restoreMasked(incoming.value, prior.value);
  restored = restored || value.restored;
  // Only materialise `value` when it was present or restored — an
  // env-only entry that never had one keeps its shape.
  if (value.restored || typeof incoming.value === 'string') out.value = value.value;

  if (incoming.env && typeof incoming.env === 'object' && prior.env) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(incoming.env)) {
      const r = restoreMasked(v, prior.env[k]);
      restored = restored || r.restored;
      env[k] = r.value;
    }
    out.env = env;
  }
  if (incoming.cache && typeof incoming.cache === 'object' && prior.cache) {
    const cache: NonNullable<Credential['cache']> = { ...incoming.cache };
    for (const k of CACHE_SECRET_KEYS) {
      if (typeof incoming.cache[k] !== 'string') continue;
      const r = restoreMasked(incoming.cache[k], prior.cache[k]);
      restored = restored || r.restored;
      cache[k] = r.value;
    }
    out.cache = cache;
  }
  if (incoming.fields && typeof incoming.fields === 'object' && prior.fields) {
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(incoming.fields)) {
      const stored = prior.fields[k];
      // The decision is made on the STORED value, as the masker made it:
      // only a secret-looking field is restored from disk. An emptied
      // `email` is a genuine edit, not the echo of a mask.
      if (typeof stored === 'string' && stored !== '' && isSecretLookingLeaf(k, stored)) {
        const r = restoreMasked(v, stored);
        restored = restored || r.restored;
        fields[k] = r.value;
      } else {
        fields[k] = v;
      }
    }
    out.fields = fields;
  }
  const inHeaders = (incoming as { headers?: unknown }).headers;
  const priorHeaders = (prior as { headers?: unknown }).headers;
  if (
    inHeaders && typeof inHeaders === 'object' && !Array.isArray(inHeaders) &&
    priorHeaders && typeof priorHeaders === 'object'
  ) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(inHeaders as Record<string, unknown>)) {
      const r = restoreMasked(v, (priorHeaders as Record<string, unknown>)[k]);
      restored = restored || r.restored;
      headers[k] = r.value;
    }
    (out as { headers?: Record<string, string> }).headers = headers;
  }
  return { entry: out, restored };
}

function normalizedList(v: unknown): string[] {
  return Array.isArray(v)
    ? (v as unknown[])
        .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
        .map(s => s.trim())
        .sort()
    : [];
}

function normalizedFields(v: unknown): string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '';
  return Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => typeof val === 'string' && val.trim() !== '')
    .map(([k, val]) => `${k}=${(val as string).trim()}`)
    .sort()
    .join('\n');
}

/** The fields that decide WHERE a stored secret is sent (`url`, `fields` —
 *  the probe and the connection-ref resolver build the request from
 *  these) and WHO may use it (`owners`, `orchestrations`). Returns the name
 *  of the first one that differs between `incoming` and `prior`, or null
 *  when none does. Pure; compared after the same normalisation
 *  `writeCredentials` applies, so a re-save of an untouched entry is never
 *  reported as a change. */
export function credentialDestinationChange(
  incoming: Credential,
  prior: Credential,
): 'url' | 'fields' | 'owners' | 'orchestrations' | null {
  const url = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  if (url(incoming.url) !== url(prior.url)) return 'url';
  if (normalizedFields(incoming.fields) !== normalizedFields(prior.fields)) {
    return 'fields';
  }
  const lists = (a: unknown, b: unknown) =>
    normalizedList(a).join('\n') === normalizedList(b).join('\n');
  if (!lists(incoming.owners, prior.owners)) return 'owners';
  if (!lists(incoming.orchestrations, prior.orchestrations)) {
    return 'orchestrations';
  }
  return null;
}

/** Async read — used by the GET/PUT API handlers. */
export async function readCredentials(
  file: string,
): Promise<CredentialsConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as CredentialsConfig;
  } catch {
    return {};
  }
}

/** Sync read — used by buildExecutorSource on the hot path so the
 *  per-provider key fallback doesn't need an await chain. The file
 *  is tiny; the read is negligible. */
export function readCredentialsSync(file: string): CredentialsConfig {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as CredentialsConfig;
  } catch {
    return {};
  }
}

export async function writeCredentials(
  file: string,
  cfg: CredentialsConfig,
): Promise<CredentialsConfig> {
  // Strip empties + non-string values. Stays defensive — the API
  // handler shouldn't have to repeat the cleanup.
  //
  // Special case: kinds where `value` isn't the primary secret
  // (mcp-server-with-env-only, aws-sso pre-signin) may legitimately
  // have an empty `value`. We accept those when they declare a `kind`
  // and at least one kind-specific field (`url`, `env`, `ssoStartUrl`,
  // etc.) — otherwise an empty entry is junk and gets dropped.
  const clean: CredentialsConfig = {};
  for (const [name, entry] of Object.entries(cfg)) {
    if (!name || typeof entry !== 'object' || !entry) continue;
    const raw = entry as Credential;
    const value = typeof raw.value === 'string' ? raw.value.trim() : '';
    const hasNonValueSubstance = !!(
      raw.kind &&
      (raw.url ||
        raw.ssoStartUrl ||
        (raw.env && Object.keys(raw.env).length > 0) ||
        (raw.fields && Object.keys(raw.fields).length > 0))
    );
    if (!value && !hasNonValueSubstance) continue;
    const e: Credential = { value };
    if (typeof raw.description === 'string' && raw.description.trim()) {
      e.description = raw.description.trim();
    }
    if (Array.isArray(raw.owners)) {
      const owners = (raw.owners as string[])
        .filter(o => typeof o === 'string' && o.trim())
        .map(o => o.trim());
      if (owners.length > 0) e.owners = owners;
    }
    if (Array.isArray(raw.orchestrations)) {
      const orchs = (raw.orchestrations as string[])
        .filter(o => typeof o === 'string' && o.trim())
        .map(o => o.trim());
      if (orchs.length > 0) e.orchestrations = orchs;
    }
    // ─── kind-tagged extensions ───
    if (typeof raw.kind === 'string' && raw.kind.trim()) {
      e.kind = raw.kind.trim() as CredentialKind;
    }
    if (typeof raw.authMethod === 'string' && raw.authMethod.trim()) {
      e.authMethod = raw.authMethod.trim() as CredentialAuthMethod;
    }
    if (raw.fields && typeof raw.fields === 'object') {
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.fields)) {
        if (typeof v === 'string' && v.trim()) fields[k] = v.trim();
      }
      if (Object.keys(fields).length > 0) e.fields = fields;
    }
    if (typeof raw.expiresAt === 'string' && raw.expiresAt.trim()) {
      e.expiresAt = raw.expiresAt.trim();
    }
    if (raw.refresh && typeof raw.refresh === 'object' && raw.refresh.via) {
      e.refresh = {
        via: String(raw.refresh.via).trim(),
        ...(raw.refresh.scope ? { scope: String(raw.refresh.scope).trim() } : {}),
      };
    }
    if (typeof raw.url === 'string' && raw.url.trim()) e.url = raw.url.trim();
    if (typeof raw.ref === 'string' && raw.ref.trim()) e.ref = raw.ref.trim();
    if (raw.env && typeof raw.env === 'object') {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.env)) {
        if (typeof v === 'string') env[k] = v;
      }
      if (Object.keys(env).length > 0) e.env = env;
    }
    // Not part of the typed shape (see `maskCredentialEntry`) — but GET
    // masks a hand-written `headers` block and `reconcileMaskedEntry`
    // restores it, so the writer must keep it or the restore has nowhere to
    // land: every PUT replaces the whole file, so saving one entry through
    // the editor erased every entry's headers, including the ones outside
    // the caller's view that the handler copies over untouched.
    const rawHeaders = (raw as { headers?: unknown }).headers;
    if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
        if (typeof v === 'string') headers[k] = v;
      }
      if (Object.keys(headers).length > 0) {
        (e as { headers?: Record<string, string> }).headers = headers;
      }
    }
    for (const k of ['ssoStartUrl', 'ssoRegion', 'accountId', 'roleName'] as const) {
      const v = raw[k];
      if (typeof v === 'string' && v.trim()) e[k] = v.trim();
    }
    if (raw.cache && typeof raw.cache === 'object') {
      const cache: NonNullable<Credential['cache']> = {};
      for (const k of [
        'accessToken',
        'accessKeyId',
        'secretAccessKey',
        'sessionToken',
        'expiresAt',
      ] as const) {
        const v = raw.cache[k];
        if (typeof v === 'string' && v.trim()) cache[k] = v.trim();
      }
      if (Object.keys(cache).length > 0) e.cache = cache;
    }
    clean[name] = e;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  return clean;
}

/** Resolve the connections file path. Precedence:
 *    1. `SAMMY_CONNECTIONS_FILE` env var (explicit override)
 *    2. `<repoRoot>/credentials.json` (default)
 *
 * `--connections <path>` CLI flag is wired in sammyPackApiPlugin
 * which passes the resolved path explicitly to this helper's callers.
 * The path is returned as-is (no existence check) — readCredentials*
 * already tolerates missing files. */
export function resolveCredentialsFile(repoRoot: string): string {
  const envPath = process.env.SAMMY_CONNECTIONS_FILE?.trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(repoRoot, envPath);
  }
  return path.join(repoRoot, 'credentials.json');
}

/** Resolve per-provider keys by canonical name. Used as the fallback
 *  when env vars aren't set. Sync — see `readCredentialsSync`. */
export function resolveProviderKeysSync(file: string): {
  openai?: string;
  gemini?: string;
  anthropic?: string;
  /** JSON AWS creds {region, accessKeyId, secretAccessKey} — see bedrock.ts. */
  bedrock?: string;
} {
  const creds = readCredentialsSync(file);
  return {
    openai: creds.openai?.value,
    gemini: creds.gemini?.value,
    anthropic: creds.anthropic?.value,
    bedrock: creds.bedrock?.value,
  };
}

/** Flatten the registry into `{ name: value }` — the shape the
 *  executor's `credentialsByName` expects for per-node credential
 *  routing. Sync — see `readCredentialsSync`.
 *
 *  Optional `scope` filter enforces per-credential `owners` and
 *  `orchestrations` allowlists: scoped entries are dropped from the
 *  resulting map when the calling context doesn't match, so the
 *  executor literally can't resolve them. Unscoped entries (no
 *  `owners`/`orchestrations` set) are always included — that's the
 *  back-compat default for entries created before scoping landed. */
export function readCredentialsByNameSync(
  file: string,
  scope?: { ownerId?: string; orchestrationName?: string },
): Record<string, string> {
  const raw = readCredentialsByNameRaw(file, scope);
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (entry.value) out[name] = entry.value;
  }
  return out;
}

/** Same scoping logic as `readCredentialsByNameSync`, but returns the
 *  full Credential entries (kind, fields, url, env, etc.) so callers
 *  that interpolate `${connections:name.fields.<key>}` can resolve
 *  beyond the bare value. Used by the MCP env expander, A2A URL
 *  resolver, and import command. Entries with neither `value` nor
 *  kind-specific substance are dropped (same gate as `writeCredentials`).
 *
 *  SCOPING RULES. `owners` is a who-may-use rule and always applies: a
 *  scoped entry resolves only for a matching `scope.ownerId`, and an
 *  anonymous read fails closed. `orchestrations` is a which-RUN-may-use
 *  rule and applies only when a run context is known, i.e. when
 *  `scope.orchestrationName` is supplied: a named orchestration must be
 *  listed, while a caller with no orchestration (the credential test
 *  probe, an ad-hoc tool-call) is not a run and is not filtered by it.
 *  Treating "no orchestration" as "no orchestration matches" dropped every
 *  entry with an `orchestrations` allowlist from the probe's owner-scoped
 *  read, so "Test connection" reported a credential that was in the file
 *  as not found. */
/**
 * Every secret-bearing value in the registry, REGARDLESS of scope — a run's
 * scrub set seeds from this, so output that echoes a credential the run was
 * never given (a test that reads credentials.json, a tool that dumps its
 * environment) is still redacted. Values, `env` values, and fields whose
 * NAME looks secret; plain identifiers (an email, a site URL) are not.
 */
export function registrySecretValues(file: string): string[] {
  const out = new Set<string>();
  for (const entry of Object.values(readCredentialsSync(file))) {
    if (!entry) continue;
    if (typeof entry.value === 'string' && entry.value.length >= 6) out.add(entry.value);
    // Only env values whose NAME looks secret (or whose value is a known
    // token format) — `AWS_REGION: us-west-2` is configuration, and adding it
    // would redact "us-west-2" from every run's output.
    for (const [k, v] of Object.entries(entry.env ?? {})) {
      if (
        typeof v === 'string' &&
        v.length >= 6 &&
        !v.includes('${connections:') &&
        (SECRET_NAME_SHAPE.test(k) || looksLikeKnownToken(v))
      ) {
        out.add(v);
      }
    }
    for (const [k, v] of Object.entries(entry.fields ?? {})) {
      if (typeof v === 'string' && v.length >= 6 && SECRET_NAME_SHAPE.test(k)) out.add(v);
    }
  }
  return [...out];
}

export function readCredentialsByNameRaw(
  file: string,
  scope?: { ownerId?: string; orchestrationName?: string },
): Record<string, Credential> {
  const creds = readCredentialsSync(file);
  const out: Record<string, Credential> = {};
  for (const [name, entry] of Object.entries(creds)) {
    if (!entry) continue;
    const hasSubstance =
      !!entry.value ||
      !!entry.url ||
      !!entry.ssoStartUrl ||
      (entry.env && Object.keys(entry.env).length > 0) ||
      (entry.fields && Object.keys(entry.fields).length > 0);
    if (!hasSubstance) continue;
    if (Array.isArray(entry.owners) && entry.owners.length > 0) {
      if (!scope?.ownerId || !entry.owners.includes(scope.ownerId)) continue;
    }
    if (
      Array.isArray(entry.orchestrations) &&
      entry.orchestrations.length > 0 &&
      scope?.orchestrationName !== undefined &&
      !entry.orchestrations.includes(scope.orchestrationName)
    ) {
      continue;
    }
    out[name] = entry;
  }
  return out;
}
