/**
 * Source registry — the explicit adapter table the connector runtime
 * dispatches `sources` bindings against.
 *
 * Registration is EXPLICIT by design (this milestone): a host installs the
 * adapter package it wants (`@sammy-pack/source-sqs`) and registers its
 * factory by the name its bindings use (`"sqs"`). Auto-discovery (scan
 * `node_modules` for `@sammy-pack/source-*` / a `package.json#sammyPack`
 * marker) is a documented follow-on — see the README. Explicit
 * registration means the runtime never imports a broker SDK: the factory
 * the host registers is the only thing that pulls one in.
 */

import type { SourceFactory } from './types.js';

/** A mutable registry of adapter factories keyed by `source` name. */
export class SourceRegistry {
  private readonly factories = new Map<string, SourceFactory>();

  /** Register (or replace) the factory for a `source` name. Returns `this`
   *  for chaining. */
  register(name: string, factory: SourceFactory): this {
    if (!name) throw new Error('source name is required');
    this.factories.set(name, factory);
    return this;
  }

  /** Look up a factory; undefined when unregistered. */
  get(name: string): SourceFactory | undefined {
    return this.factories.get(name);
  }

  /** True when `name` has a registered factory. */
  has(name: string): boolean {
    return this.factories.has(name);
  }

  /** The registered source names (for diagnostics / clear errors). */
  names(): string[] {
    return [...this.factories.keys()];
  }
}

/** Convenience constructor: build a registry from a name→factory map. */
export function createRegistry(
  factories: Record<string, SourceFactory> = {},
): SourceRegistry {
  const reg = new SourceRegistry();
  for (const [name, factory] of Object.entries(factories)) {
    reg.register(name, factory);
  }
  return reg;
}
