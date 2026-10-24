/**
 * @sammy-pack/queue-service — public types.
 *
 * The connector runtime is broker-AGNOSTIC: it knows the SDK's
 * `QueueSource` contract and nothing about any specific broker. Adapters
 * (`@sammy-pack/source-sqs`, `-kafka`, `-rabbitmq`, third-party …) are
 * registered explicitly as factories; the runtime hosts their consume
 * loops and manages their lifecycle.
 */

import type { QueueSource } from '@sammy-pack/sdk';

/**
 * A declarative binding of one broker to one `queue` trigger. This is the
 * `sources` entry shape from the ADR's roadmap:
 *
 *   { source, ...config, credentialRef, deliversTo }
 *
 * - `source` selects a REGISTERED adapter factory by name ("sqs", …).
 * - `deliversTo` names the `queue` trigger the messages land at
 *   (`POST /api/queue/<deliversTo>`).
 * - `credentialRef` (optional) names a credential-registry entry whose
 *   resolved fields configure the broker client (e.g. an `aws` entry).
 * - every OTHER key is adapter-specific config (queueUrl, brokers, topic,
 *   …) and is passed through to the factory verbatim.
 *
 * The runtime never interprets broker-specific config — it just resolves
 * the credential and hands `{ config, credential, deliver, signal }` to
 * the matching factory.
 */
export interface SourceBinding {
  /** Registered adapter name. Must match a `registerSource(name, …)`. */
  source: string;
  /** The `queue` trigger name messages are delivered to. */
  deliversTo: string;
  /** Optional credential-registry entry name resolved for this binding. */
  credentialRef?: string;
  /** Adapter-specific config (queueUrl, brokers, topic, queueName, …).
   *  Anything not consumed by the runtime itself. */
  [key: string]: unknown;
}

/**
 * A credential resolved from the registry, normalized to the subset a
 * broker adapter needs. Mirrors the engine's `Credential` shape (value +
 * kind + non-secret `fields`), but the runtime depends on a
 * `CredentialResolver` rather than the engine, so it stays
 * engine-independent.
 */
export interface ResolvedCredential {
  /** The primary secret (e.g. a static access key, an API token). May be
   *  empty for kinds whose auth doesn't use a bare value (role/SSO). */
  value?: string;
  /** Discriminator from the registry ("aws", "secret", …). */
  kind?: string;
  /** Non-secret companion fields (region, accountId, brokers, …). */
  fields?: Record<string, string>;
  /** Top-level extras the registry carries for some kinds (ssoRegion,
   *  accountId, roleName …). Passed through so adapters can use them. */
  extras?: Record<string, string>;
}

/**
 * Resolves a `credentialRef` to a `ResolvedCredential` (or undefined when
 * the ref is absent / unknown). Injected into the runtime so credential
 * storage stays the host's concern. `defaultFileCredentialResolver`
 * provides a registry-file-backed implementation; a host embedding the
 * runtime inside the engine can pass one backed by `credentials-store.ts`.
 */
export type CredentialResolver = (
  ref: string,
) => Promise<ResolvedCredential | undefined> | ResolvedCredential | undefined;

/**
 * Builds a `QueueSource` for one binding. Registered per adapter name.
 * Receives the binding's adapter-specific `config`, the resolved
 * `credential` (if any), and the server `baseUrl` so it can construct its
 * `deliver` via the SDK's `makeHttpDeliver`. The runtime owns the
 * lifecycle — the factory only constructs.
 */
export type SourceFactory = (args: {
  /** Adapter-specific config from the binding (credentialRef/source/
   *  deliversTo stripped out). */
  config: Record<string, unknown>;
  /** Resolved credential for `credentialRef`, if the binding named one. */
  credential?: ResolvedCredential;
  /** The `queue` trigger name (binding.deliversTo). */
  deliversTo: string;
  /** sammy-pack server base URL the adapter delivers to. */
  baseUrl: string;
  /** Optional HMAC secret for signed `queue` triggers (from env). */
  signingSecret?: string;
}) => QueueSource | Promise<QueueSource>;

/** Lifecycle states a hosted connector moves through. */
export type ConnectorState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed';

/** Observable status of one hosted connector (one binding). */
export interface ConnectorStatus {
  /** binding.source */
  source: string;
  /** binding.deliversTo */
  deliversTo: string;
  state: ConnectorState;
  /** Set when the loop rejected (it shouldn't — adapters resolve on clean
   *  shutdown — but a construction error or a buggy adapter surfaces here). */
  error?: string;
}
