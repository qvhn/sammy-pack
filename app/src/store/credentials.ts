/**
 * Browser client for the server-side credentials registry. The
 * registry lives at `<repoRoot>/credentials.json` (or wherever
 * `SAMMY_CONNECTIONS_FILE` points); the server reads it for
 * provider-key fallback and (when nodes opt in via `credential: "name"`)
 * per-phase key resolution.
 *
 * The Credential shape mirrors the server-side `Credential` type in
 * `server/credentials-store.ts` — kept in sync intentionally so the
 * Connections UI can read/write all kind-tagged fields. New fields
 * here must be added there too.
 */

import { requestFailure } from '../api';

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

export type Credential = {
  value: string;
  description?: string;
  /** Per-credential scoping. When set, only runs whose owner matches
   *  one of these IDs can resolve this credential. Empty/missing =
   *  unrestricted. */
  owners?: string[];
  /** Per-credential orchestration allowlist. When set, only the
   *  listed orchestration names can reference this credential.
   *  Empty/missing = unrestricted. */
  orchestrations?: string[];
  // ─── kind-tagged extensions (optional; absent = legacy "secret") ───
  kind?: CredentialKind;
  authMethod?: string;
  fields?: Record<string, string>;
  expiresAt?: string;
  refresh?: { via: string; scope?: string };
  url?: string;
  ref?: string;
  env?: Record<string, string>;
  ssoStartUrl?: string;
  ssoRegion?: string;
  accountId?: string;
  roleName?: string;
  cache?: {
    accessToken?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    expiresAt?: string;
  };
};

export type CredentialsMap = Record<string, Credential>;

// ─── The masked round trip, as the editor sees it ───
//
// GET returns every secret-bearing field masked (`maskCredentialEntry` on
// the server): a long secret as `ABCDEF…89`, a short one as the fixed
// SHORT_VALUE_MASK, and only a genuinely empty value as ''. The editor
// shows exactly that and sends it back as-is; PUT restores whatever comes
// back as a mask (or as '' while a value is stored) from disk — and then
// REFUSES to move an entry whose secret it had to restore: `url` / `fields`
// decide where the stored secret is sent, `owners` / `orchestrations` who
// may use it, and a caller who never saw the secret must not be able to
// re-point it. The helpers below let the editor honour that contract up
// front instead of discovering it as a 400 after the fact.

/** What the server sends for a stored value too short to show a prefix of
 *  (≤ 8 chars): a fixed, obviously synthetic token that says "there is a
 *  value here and you may not see it". Shown as-is, sent back as-is — the
 *  server recognises its own mask and restores the real value. Mirrors
 *  `SHORT_VALUE_MASK` in `server/credentials-store.ts`; the browser bundle
 *  cannot import server code, so the literal is repeated here and
 *  `credentials-mask-parity.test.ts` pins the two together. */
export const SHORT_VALUE_MASK = '••••••••';

/** The fields the server refuses to change while the entry's secret is
 *  masked, in the order it checks them. */
export type SecretBoundField = 'url' | 'fields' | 'owners' | 'orchestrations';

/** The secret-bearing blocks of an entry — the ones `maskCredentialEntry`
 *  masks on GET and `reconcileMaskedEntry` restores on PUT. `fields` is
 *  non-secret BY DESIGN (site URL, email, region) but free-form, so the
 *  server masks and restores it PER KEY; leaving it off this list is what
 *  put the server's 400 back in front of the operator with no hint. */
export type SecretBlock = 'value' | 'env' | 'cache' | 'headers' | 'fields';

/** The editor's draft of an entry — the pieces of the form that bear on
 *  the server's re-enter rule: every secret-bearing block (what the server
 *  may have to restore) and the destination / audience fields (what it then
 *  refuses to move). */
export type CredentialDraft = {
  value: string;
  env?: Record<string, unknown>;
  cache?: Credential['cache'];
  headers?: Record<string, unknown>;
  url?: string;
  fields?: Record<string, string>;
  owners?: string[];
  orchestrations?: string[];
};

/** The `cache` members that are credentials in their own right — the same
 *  list the server masks and restores. */
const CACHE_SECRET_KEYS = [
  'accessToken',
  'accessKeyId',
  'secretAccessKey',
  'sessionToken',
] as const;

/** Would the server restore this one secret from disk? Mirrors its
 *  `restoreMasked`: a stored secret exists (GET sent a non-empty mask) and
 *  the draft still holds that mask, or nothing. The editor never sees the
 *  stored value, but what GET sent IS `maskSecret(stored)`, so "equal to
 *  what GET sent" is exactly the server's `isMaskOf`. */
function restoredFrom(draft: unknown, sent: unknown): boolean {
  const sentMask = typeof sent === 'string' ? sent : '';
  if (sentMask === '') return false;
  const v = typeof draft === 'string' ? draft : '';
  return v === '' || v === sentMask;
}

function restoredAnyIn(
  draft: Record<string, unknown> | undefined,
  sent: Record<string, unknown> | undefined,
): boolean {
  if (!draft || !sent) return false;
  return Object.entries(draft).some(([k, v]) => restoredFrom(v, sent[k]));
}

/** Did GET mask THIS leaf? Needed only for `fields`, the one block the
 *  server decides per key — on the STORED value, which the editor never
 *  sees. What it can see is that every masked leaf GET sends is
 *  `maskSecret(stored)`: `SHORT_VALUE_MASK`, or a prefix and tail joined by
 *  an ellipsis. Without this test an untouched readable `email` would count
 *  as restored and disable Save for every move of every entry. */
function looksMasked(sent: unknown): boolean {
  return (
    typeof sent === 'string' &&
    (sent === SHORT_VALUE_MASK || sent.includes('…'))
  );
}

/** The `fields` keys whose secret the server would restore from disk — the
 *  masked ones the draft still echoes. The editor needs the KEYS, not just
 *  the block, to put the hint on the input that is holding the save up; a
 *  masked key the active kind declares no control for can only be retyped as
 *  raw JSON.
 *
 *  Decided over the `fields` map the save will actually SEND: `handleSave`
 *  builds it with `if (v?.trim())`, so a key the operator cleared is dropped
 *  from the PUT body, and the server restores only the keys it receives —
 *  a cleared key is a deletion it accepts, not a secret left masked.
 *  Counting it (`restoredFrom` treats `''` as restored, which is right for a
 *  key that IS sent) disabled Save behind a hint the form cannot satisfy:
 *  the mask can be re-typed or replaced, never deleted. */
export function maskedFieldKeys(
  draft: CredentialDraft,
  initial: Credential | undefined,
): string[] {
  if (!draft.fields || !initial?.fields) return [];
  const sent = initial.fields as Record<string, unknown>;
  return Object.entries(draft.fields)
    .map(([k, v]) => [k, typeof v === 'string' ? v.trim() : ''] as const)
    .filter(([k, v]) => v !== '' && looksMasked(sent[k]) && restoredFrom(v, sent[k]))
    .map(([k]) => k);
}

/** The secret-bearing blocks the server would restore from disk if the
 *  draft were saved now — i.e. the secrets the caller has NOT re-entered.
 *  Empty when the draft may move freely: every stored secret was re-typed,
 *  or the entry has none. Block by block as `reconcileMaskedEntry` walks
 *  them: `value`, each `env` key the draft sends, the `cache` credentials,
 *  each `headers` key, each secret-looking `fields` key. A block the draft
 *  does not send is not restored (the server drops it), so the form carries
 *  the blocks it has no controls for over unchanged — see `handleSave` in
 *  ConnectionsPage. */
export function maskedSecretBlocks(
  draft: CredentialDraft,
  initial: Credential | undefined,
): SecretBlock[] {
  if (!initial) return [];
  const out: SecretBlock[] = [];
  if (restoredFrom(draft.value.trim(), initial.value)) out.push('value');
  if (restoredAnyIn(draft.env, initial.env)) out.push('env');
  if (
    draft.cache &&
    initial.cache &&
    CACHE_SECRET_KEYS.some(
      k =>
        typeof draft.cache![k] === 'string' &&
        restoredFrom(draft.cache![k], initial.cache![k]),
    )
  ) {
    out.push('cache');
  }
  const sentHeaders = (initial as { headers?: unknown }).headers;
  if (
    restoredAnyIn(
      draft.headers,
      sentHeaders && typeof sentHeaders === 'object' && !Array.isArray(sentHeaders)
        ? (sentHeaders as Record<string, unknown>)
        : undefined,
    )
  ) {
    out.push('headers');
  }
  if (maskedFieldKeys(draft, initial).length > 0) out.push('fields');
  return out;
}

function normalizedList(v: unknown): string {
  return Array.isArray(v)
    ? (v as unknown[])
        .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
        .map(s => s.trim())
        .sort()
        .join('\n')
    : '';
}

function normalizedFields(v: unknown): string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '';
  return Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => typeof val === 'string' && val.trim() !== '')
    .map(([k, val]) => `${k}=${(val as string).trim()}`)
    .sort()
    .join('\n');
}

/** Which secret-bound field the draft moves while ANY of the entry's
 *  secrets is still the masked one — i.e. the save the server would refuse
 *  with "Re-enter the secret". null when the draft can be saved as-is:
 *  nothing moved, every secret was re-typed, or the entry has none to
 *  protect.
 *
 *  "Still masked" is `maskedSecretBlocks`: the server refuses while it had
 *  to restore ANY secret — a re-typed `value` does not free an entry whose
 *  `env` / `headers` / `cache` / `fields` still echo their masks. The
 *  comparisons mirror `credentialDestinationChange` on the server: trimmed
 *  `url`, the non-empty `fields` as sorted `k=v` lines, the lists
 *  order-insensitive — so a re-save of an untouched entry is never
 *  flagged. */
export function secretReentryRequired(
  draft: CredentialDraft,
  initial: Credential | undefined,
): SecretBoundField | null {
  if (!initial) return null;
  if (maskedSecretBlocks(draft, initial).length === 0) return null;
  const url = (s: unknown) => (typeof s === 'string' ? s.trim() : '');
  if (url(draft.url) !== url(initial.url)) return 'url';
  if (normalizedFields(draft.fields) !== normalizedFields(initial.fields)) {
    return 'fields';
  }
  if (normalizedList(draft.owners) !== normalizedList(initial.owners)) {
    return 'owners';
  }
  if (
    normalizedList(draft.orchestrations) !==
    normalizedList(initial.orchestrations)
  ) {
    return 'orchestrations';
  }
  return null;
}

export async function getCredentials(): Promise<CredentialsMap> {
  const res = await fetch('/api/credentials');
  if (!res.ok) throw await requestFailure('GET /api/credentials', res);
  return (await res.json()) as CredentialsMap;
}

export async function saveCredentials(
  cfg: CredentialsMap,
): Promise<CredentialsMap> {
  const res = await fetch('/api/credentials', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) throw await requestFailure('PUT /api/credentials', res);
  return (await res.json()) as CredentialsMap;
}

/** Result shape returned by POST /api/credentials/import. */
export type ImportResult = {
  added: string[];
  updated: string[];
  unchanged: string[];
  skipped: Array<{ source: string; reason: string }>;
  registry: CredentialsMap;
  dryRun: boolean;
};

/**
 * Migration helper. Send the browser's localStorage snapshot to the
 * server; the server adds env-var + MCP env-block fallbacks and
 * returns a merged registry. With `dryRun: true`, the file isn't
 * written — useful for showing a preview before commit.
 *
 * Pass *every* localStorage key the user has — the server filters by
 * pattern. Cheaper to over-send than to scan twice.
 */
export async function importCredentials(args: {
  localStorage: Record<string, string>;
  dryRun?: boolean;
}): Promise<ImportResult> {
  const res = await fetch('/api/credentials/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw await requestFailure('POST /api/credentials/import', res);
  return (await res.json()) as ImportResult;
}

/** Result of POST /api/credentials/test — live probe against the
 *  resolved service endpoint. */
export type TestConnectionResult = {
  ok: boolean;
  status?: number;
  message: string;
  probedUrl?: string;
};

/** Hit the service-specific health probe (configured via
 *  `ConnectionKindDef.testProbe`). Pass `name` for a saved entry, or
 *  use the override fields to probe values that haven't been saved
 *  yet (the Add form's "Test connection" before-save use case).
 *
 *  Returns ok+status when the probe succeeds (2xx), ok=false +
 *  message when it doesn't. Never throws for HTTP failures — the
 *  endpoint reports them as `{ok:false, ...}`. */
export async function testConnection(args: {
  name: string;
  urlOverride?: string;
  valueOverride?: string;
  fieldsOverride?: Record<string, string>;
}): Promise<TestConnectionResult> {
  const res = await fetch('/api/credentials/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: (await requestFailure('POST /api/credentials/test', res)).message,
    };
  }
  return (await res.json()) as TestConnectionResult;
}

export type UsageRow = {
  directRefs: string[];
  viaMcp: Array<{ orch: string; mcpName: string }>;
};
export type UsageMap = Record<string, UsageRow>;

/** Server-computed reverse index: for each credential name, which
 *  orchestrations in examples/ reference it (directly via
 *  `credential: "name"` or transitively via an MCP server whose env
 *  block uses `${connections:name...}`). Cached at the
 *  ConnectionsPage level — the server walks examples/ on every
 *  request, but the page only re-fetches on save / refresh. */
export async function getCredentialsUsage(): Promise<UsageMap> {
  const res = await fetch('/api/credentials/usage');
  if (!res.ok) throw await requestFailure('GET /api/credentials/usage', res);
  return (await res.json()) as UsageMap;
}

/** Snapshot every localStorage entry starting with `sammy.` — covers
 *  provider keys, connection tokens, and connection extras. Safe to
 *  call from anywhere; returns `{}` server-side / in jsdom-less
 *  environments. */
export function snapshotSammyLocalStorage(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    if (typeof localStorage === 'undefined') return out;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('sammy.')) continue;
      const value = localStorage.getItem(key);
      if (value != null) out[key] = value;
    }
  } catch {
    /* no-op */
  }
  return out;
}
