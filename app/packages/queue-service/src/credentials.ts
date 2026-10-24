/**
 * Credential resolution — a minimal, engine-INDEPENDENT reader for the
 * sammy-pack credential registry file.
 *
 * The connector runtime resolves a binding's `credentialRef` through an
 * injected `CredentialResolver` so credential STORAGE stays the host's
 * concern (and the runtime depends on `@sammy-pack/sdk` only, never the
 * engine). This module ships the default resolver: it reads the same
 * `credentials.json` the engine's credential registry writes
 * (`credentials-store.ts`) — the registry already has an `aws` kind — and
 * normalizes an entry to the `ResolvedCredential` subset adapters need.
 *
 * Resolution honors `SAMMY_CONNECTIONS_FILE` (the same env var the engine
 * uses to relocate the registry) so a connector process and the server
 * read the SAME file with no extra config.
 *
 * A host embedding the runtime IN-PROCESS can instead pass a resolver
 * backed directly by `credentials-store.ts` (`readCredentialsByNameRaw`)
 * to inherit owner/orchestration scoping — that's a one-line override.
 */

import { readFile } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import type { CredentialResolver, ResolvedCredential } from './types.js';

const readFileAsync = promisify(readFile);

/** The subset of a registry entry this reader understands. The on-disk
 *  shape carries more (owners, refresh, cache, …); we only lift what an
 *  adapter could use to configure a broker client. */
interface RegistryEntry {
  value?: string;
  kind?: string;
  fields?: Record<string, string>;
  // Top-level extras some kinds (notably `aws`) store outside `fields`.
  ssoStartUrl?: string;
  ssoRegion?: string;
  accountId?: string;
  roleName?: string;
}

const TOP_LEVEL_EXTRA_KEYS = [
  'ssoStartUrl',
  'ssoRegion',
  'accountId',
  'roleName',
] as const;

/** Resolve the registry file path. Mirrors the engine's precedence:
 *    1. `SAMMY_CONNECTIONS_FILE` env var (explicit override)
 *    2. `<cwd>/credentials.json` (default) */
export function resolveCredentialsFile(cwd: string = process.cwd()): string {
  const envPath = process.env.SAMMY_CONNECTIONS_FILE?.trim();
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(cwd, envPath);
  }
  return path.join(cwd, 'credentials.json');
}

/** Normalize a raw registry entry to the adapter-facing subset. */
function normalize(entry: RegistryEntry): ResolvedCredential {
  const out: ResolvedCredential = {};
  if (typeof entry.value === 'string' && entry.value) out.value = entry.value;
  if (typeof entry.kind === 'string' && entry.kind) out.kind = entry.kind;
  if (entry.fields && typeof entry.fields === 'object') {
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(entry.fields)) {
      if (typeof v === 'string') fields[k] = v;
    }
    if (Object.keys(fields).length > 0) out.fields = fields;
  }
  const extras: Record<string, string> = {};
  for (const k of TOP_LEVEL_EXTRA_KEYS) {
    const v = entry[k];
    if (typeof v === 'string' && v) extras[k] = v;
  }
  if (Object.keys(extras).length > 0) out.extras = extras;
  return out;
}

/**
 * The default file-backed `CredentialResolver`. Reads (and parses) the
 * registry file once per call; the file is tiny so this is negligible, and
 * reading fresh means a rotated secret is picked up on the next connector
 * (re)start without restarting the resolver. Returns undefined for an
 * unknown ref or an unreadable/missing file (the runtime then starts the
 * binding with no credential — correct for adapters that read creds from
 * the ambient environment, e.g. an SQS adapter using the AWS default chain).
 */
export function defaultFileCredentialResolver(
  file: string = resolveCredentialsFile(),
): CredentialResolver {
  return async (ref: string): Promise<ResolvedCredential | undefined> => {
    if (!ref) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFileAsync(file, 'utf8'));
    } catch {
      return undefined;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const entry = (raw as Record<string, RegistryEntry>)[ref];
    if (!entry || typeof entry !== 'object') return undefined;
    return normalize(entry);
  };
}
