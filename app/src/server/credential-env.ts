/**
 * Credential → subprocess environment mapping.
 *
 * SECURITY: this module is the ONLY sanctioned path that turns a
 * resolved credential's plaintext secret into an `env` map. That map is
 * handed straight to the Claude Agent SDK's `query({ options.env })`,
 * which sets the spawned agent subprocess's OS environment. The secret
 * therefore reaches ONLY the subprocess env — it is never concatenated
 * into a system prompt, user message, model context, event log, or any
 * API response. Callers MUST keep it that way: pass the result to
 * `streamFn({ env })`, never interpolate it into prompt text.
 *
 * Server-only. Domain-agnostic — the mapping is keyed on the GENERIC
 * credential `kind` (jira / github / bitbucket / openai / …), with no
 * app- or domain-specific strings.
 */

import type { Credential, CredentialKind } from './credentials-store';

/** Describes how one credential kind projects onto subprocess env vars.
 *  `secretVar` receives the credential's `value` (the secret). `fieldVars`
 *  map non-secret `fields.<key>` entries onto additional env vars (e.g. a
 *  Jira base URL or account email). A field var is emitted only when the
 *  field is present + non-empty, so an optional field never produces an
 *  empty env entry. */
type EnvMapping = {
  /** Env var that receives the secret `value`. Omitted for kinds whose
   *  secret isn't a single bearer string (e.g. aws — handled elsewhere). */
  secretVar?: string;
  /** fields.<sourceKey> → ENV_VAR. Only emitted when the field exists. */
  fieldVars?: Array<{ field: string; envVar: string }>;
};

/** The mapping table. Data-driven on purpose: adding a kind is one entry.
 *  Kinds absent here resolve to {} (no env) — see `credentialToEnv`. */
const ENV_MAPPINGS: Partial<Record<CredentialKind, EnvMapping>> = {
  // Atlassian / Jira — Basic auth: email + API token against a base URL.
  // Both kinds map to the same env var names so an agent's curl works
  // regardless of which kind the entry was created under. Note the field
  // key differs by kind (atlassian uses `site`, the legacy `jira` alias
  // uses `siteUrl`) — we read BOTH so either lands in JIRA_BASE_URL.
  jira: {
    secretVar: 'JIRA_API_TOKEN',
    fieldVars: [
      { field: 'email', envVar: 'JIRA_EMAIL' },
      { field: 'siteUrl', envVar: 'JIRA_BASE_URL' },
      { field: 'site', envVar: 'JIRA_BASE_URL' },
    ],
  },
  atlassian: {
    secretVar: 'JIRA_API_TOKEN',
    fieldVars: [
      { field: 'email', envVar: 'JIRA_EMAIL' },
      { field: 'site', envVar: 'JIRA_BASE_URL' },
      { field: 'siteUrl', envVar: 'JIRA_BASE_URL' },
    ],
  },
  github: {
    secretVar: 'GITHUB_TOKEN',
  },
  gitlab: {
    secretVar: 'GITLAB_TOKEN',
  },
  bitbucket: {
    secretVar: 'BITBUCKET_TOKEN',
    fieldVars: [{ field: 'username', envVar: 'BITBUCKET_USERNAME' }],
  },
  linear: {
    secretVar: 'LINEAR_API_KEY',
  },
  figma: {
    secretVar: 'FIGMA_API_KEY',
  },
  notion: {
    secretVar: 'NOTION_API_KEY',
  },
  slack: {
    secretVar: 'SLACK_BOT_TOKEN',
  },
  // LLM provider keys — conventional var names. These let a phase put a
  // provider key into the agent subprocess env (e.g. so a Bash step can
  // call the provider's CLI) WITHOUT it appearing anywhere else.
  openai: {
    secretVar: 'OPENAI_API_KEY',
  },
  anthropic: {
    secretVar: 'ANTHROPIC_API_KEY',
  },
  gemini: {
    secretVar: 'GEMINI_API_KEY',
  },
  // `secret` / `api-key` are generic, kind-less buckets with no canonical
  // env var. They route via provider/credential only — not env injection.
  // `aws`, `mcp-server`, `a2a` have their own resolution paths (SigV4,
  // MCP env block, A2A URL) and intentionally inject nothing here.
};

/**
 * Project a resolved credential onto the env map that should be merged
 * into the agent subprocess environment.
 *
 * - Maps `value` → the kind's `secretVar` (when both exist + value is
 *   non-empty).
 * - Maps each present `fields.<key>` → its `envVar`.
 * - An UNKNOWN kind (or one with no mapping) returns `{}` — never throws.
 *   That's deliberate: declaring `credential` on a kind we don't map is a
 *   no-op for env injection, not a hard failure (the provider-routing path
 *   may still use it).
 *
 * The returned object contains plaintext secret(s). Hand it ONLY to the
 * SDK `env` option. Do not log it, return it over the API, or splice it
 * into prompt text.
 */
export function credentialToEnv(cred: Credential): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cred || typeof cred !== 'object') return out;
  const kind = (cred.kind ?? 'secret') as CredentialKind;
  const mapping = ENV_MAPPINGS[kind];
  if (!mapping) return out;
  if (mapping.secretVar && typeof cred.value === 'string' && cred.value.trim()) {
    out[mapping.secretVar] = cred.value;
  }
  if (mapping.fieldVars && cred.fields) {
    for (const { field, envVar } of mapping.fieldVars) {
      // Don't clobber a var already set by an earlier field alias (e.g.
      // `site` then `siteUrl` both target JIRA_BASE_URL — first non-empty
      // wins so a populated alias isn't overwritten by an empty one).
      if (out[envVar]) continue;
      const v = cred.fields[field];
      if (typeof v === 'string' && v.trim()) out[envVar] = v;
    }
  }
  return out;
}

/**
 * Merge several credentials' env maps into one. Later entries win on key
 * collision (callers pass creds in declaration order; the last one's
 * value takes precedence — matching how a shell `export` chain behaves).
 * Pure projection — no I/O.
 */
export function credentialsToEnv(
  creds: Credential[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of creds) {
    Object.assign(out, credentialToEnv(c));
  }
  return out;
}

/** The set of env var names this module can emit.
 *
 *  This used to claim it was "used by the secret scrubber". It was not —
 *  nothing outside its own test ever called it, so a reader auditing the
 *  scrubbing story found a documented control that did not exist. The actual
 *  redaction of per-phase credential values happens through the run's
 *  `injectedSecrets` set (collected in run-runner as each value is resolved),
 *  and the SERVER's own env secrets are covered by `serverSecretValues()` in
 *  scrub-secrets.ts.
 *
 *  Kept because it is the honest answer to "which env keys does credential
 *  injection write?", which the docs and the connections UI both need. */
export function secretEnvVarNames(): Set<string> {
  const names = new Set<string>();
  for (const mapping of Object.values(ENV_MAPPINGS)) {
    if (mapping?.secretVar) names.add(mapping.secretVar);
  }
  return names;
}
