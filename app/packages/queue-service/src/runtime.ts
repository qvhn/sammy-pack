/**
 * Connector runtime — hosts registered `QueueSource` adapters and manages
 * their consume-loop lifecycle.
 *
 * Broker-AGNOSTIC: it depends on `@sammy-pack/sdk` (the `QueueSource`
 * contract + `makeHttpDeliver`) and nothing broker-specific. For each
 * declarative `sources` binding it:
 *
 *   1. looks up the registered factory for `binding.source`,
 *   2. resolves `binding.credentialRef` via the injected resolver,
 *   3. asks the factory to construct a `QueueSource`, and
 *   4. starts the source's loop under a per-connector AbortSignal,
 *      tracking lifecycle state.
 *
 * `stop()` aborts every loop and awaits them — adapters resolve (not
 * reject) on a clean shutdown, per the contract. The runtime adds NO new
 * reliability surface: every message still flows through the same
 * `httpDeliver` narrow waist, so the ack-iff-2xx guarantee is unchanged.
 */

import { makeHttpDeliver, type DeliverFn, type QueueSource } from '@sammy-pack/sdk';
import type { SourceRegistry } from './registry.js';
import type {
  ConnectorStatus,
  CredentialResolver,
  ResolvedCredential,
  SourceBinding,
} from './types.js';

/** Keys the runtime consumes itself; everything else in a binding is
 *  adapter-specific config passed through to the factory. */
const RESERVED_BINDING_KEYS = new Set(['source', 'deliversTo', 'credentialRef']);

export interface QueueServiceOptions {
  /** Adapter factories, keyed by `source` name. */
  registry: SourceRegistry;
  /** Declarative bindings to host. */
  bindings: SourceBinding[];
  /** sammy-pack server base URL every adapter delivers to. */
  baseUrl: string;
  /** Resolves a binding's `credentialRef`. Optional — bindings without a
   *  ref (or all bindings) work with no resolver. */
  credentialResolver?: CredentialResolver;
  /** HMAC secret for signed `queue` triggers; passed to each factory.
   *  Typically `process.env.SAMMY_WEBHOOK_SECRET`. */
  signingSecret?: string;
  /** Optional structured logger. Defaults to no-op. */
  log?: (msg: string) => void;
}

interface Connector {
  binding: SourceBinding;
  status: ConnectorStatus;
  controller: AbortController;
  /** The running loop promise (resolves on clean shutdown). */
  loop?: Promise<void>;
}

/**
 * Validate a list of bindings against a registry WITHOUT starting
 * anything. Returns a list of human-readable problems (empty = all good).
 * Surfaced by the CLI and usable by a host before `start()`.
 */
export function validateBindings(
  bindings: SourceBinding[],
  registry: SourceRegistry,
): string[] {
  const problems: string[] = [];
  bindings.forEach((b, i) => {
    const at = `sources[${i}]`;
    if (!b || typeof b !== 'object') {
      problems.push(`${at}: not an object`);
      return;
    }
    if (!b.source) problems.push(`${at}: missing "source"`);
    else if (!registry.has(b.source)) {
      problems.push(
        `${at}: no adapter registered for source "${b.source}" ` +
          `(registered: ${registry.names().join(', ') || 'none'})`,
      );
    }
    if (!b.deliversTo) problems.push(`${at}: missing "deliversTo"`);
  });
  return problems;
}

/** Strip the runtime-reserved keys, leaving adapter-specific config. */
function configFor(binding: SourceBinding): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(binding)) {
    if (!RESERVED_BINDING_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * The connector runtime. Construct with a registry + bindings, then
 * `start()`; `stop()` for graceful shutdown. One instance hosts many
 * bindings; each runs in its own consume loop under its own AbortSignal so
 * one source stopping/failing doesn't disturb the others.
 */
export class QueueService {
  private readonly opts: Required<Pick<QueueServiceOptions, 'baseUrl' | 'registry' | 'bindings'>> &
    QueueServiceOptions;
  private readonly log: (msg: string) => void;
  private connectors: Connector[] = [];
  private started = false;

  constructor(opts: QueueServiceOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  /** Current status of every hosted connector (a snapshot). */
  statuses(): ConnectorStatus[] {
    return this.connectors.map(c => ({ ...c.status }));
  }

  /**
   * Resolve credentials, construct each source via its factory, and start
   * its loop. Returns once every loop has been LAUNCHED (not finished) —
   * loops run until `stop()`. Idempotent guard: a second call throws.
   *
   * A binding whose factory throws (bad config, etc.) is marked `failed`
   * and SKIPPED — it does not abort the other connectors. The set of such
   * failures is returned so a caller (CLI) can decide whether to proceed.
   */
  async start(): Promise<{ started: number; failed: ConnectorStatus[] }> {
    if (this.started) throw new Error('QueueService already started');
    this.started = true;

    const problems = validateBindings(this.opts.bindings, this.opts.registry);
    if (problems.length > 0) {
      throw new Error(`invalid sources binding:\n  - ${problems.join('\n  - ')}`);
    }

    const failed: ConnectorStatus[] = [];
    for (const binding of this.opts.bindings) {
      const controller = new AbortController();
      const status: ConnectorStatus = {
        source: binding.source,
        deliversTo: binding.deliversTo,
        state: 'starting',
      };
      const connector: Connector = { binding, status, controller };
      this.connectors.push(connector);

      let source: QueueSource;
      try {
        const credential = await this.resolveCredential(binding);
        const factory = this.opts.registry.get(binding.source)!;
        source = await factory({
          config: configFor(binding),
          credential,
          deliversTo: binding.deliversTo,
          baseUrl: this.opts.baseUrl,
          signingSecret: this.opts.signingSecret,
        });
      } catch (err) {
        status.state = 'failed';
        status.error = (err as Error)?.message ?? String(err);
        failed.push({ ...status });
        this.log(
          `connector "${binding.source}" → "${binding.deliversTo}" failed to construct: ${status.error}`,
        );
        continue;
      }

      const deliver: DeliverFn = makeHttpDeliver({
        baseUrl: this.opts.baseUrl,
        queue: binding.deliversTo,
        signing: this.opts.signingSecret
          ? { secret: this.opts.signingSecret }
          : undefined,
      });

      status.state = 'running';
      this.log(
        `connector "${binding.source}" → /api/queue/${binding.deliversTo} started`,
      );
      // Launch the loop; track completion. The contract says start()
      // resolves on clean shutdown and should not reject — but guard anyway
      // so a misbehaving adapter surfaces as `failed`, not an unhandled
      // rejection.
      connector.loop = source
        .start({ deliver, signal: controller.signal })
        .then(() => {
          if (connector.status.state !== 'failed') {
            connector.status.state = 'stopped';
          }
        })
        .catch((err: unknown) => {
          connector.status.state = 'failed';
          connector.status.error = (err as Error)?.message ?? String(err);
          this.log(
            `connector "${binding.source}" → "${binding.deliversTo}" loop rejected: ${connector.status.error}`,
          );
        });
    }

    const started = this.connectors.filter(c => c.status.state === 'running').length;
    return { started, failed };
  }

  /**
   * Gracefully stop every connector: abort each signal, then await every
   * loop. Safe to call before/without `start()` (no-op) and more than once.
   */
  async stop(): Promise<void> {
    for (const c of this.connectors) {
      if (c.status.state === 'running') c.status.state = 'stopping';
      c.controller.abort();
    }
    await Promise.all(this.connectors.map(c => c.loop).filter(Boolean));
    for (const c of this.connectors) {
      if (c.status.state === 'stopping') c.status.state = 'stopped';
    }
    this.log('all connectors stopped');
  }

  private async resolveCredential(
    binding: SourceBinding,
  ): Promise<ResolvedCredential | undefined> {
    if (!binding.credentialRef) return undefined;
    if (!this.opts.credentialResolver) {
      throw new Error(
        `binding for "${binding.source}" names credentialRef ` +
          `"${binding.credentialRef}" but no credentialResolver was configured`,
      );
    }
    const resolved = await this.opts.credentialResolver(binding.credentialRef);
    if (!resolved) {
      this.log(
        `credentialRef "${binding.credentialRef}" for "${binding.source}" ` +
          `did not resolve — starting with ambient credentials`,
      );
    }
    return resolved;
  }
}
