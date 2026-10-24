/**
 * @sammy-pack/sdk — the small, STABLE public contract third-party
 * integrations build against.
 *
 * This package is the public boundary of the sammy-pack ecosystem. A
 * broker adapter (`@sammy-pack/source-sqs`, `@sammy-pack/source-kafka`, a
 * third-party `@their-org/sammy-source-foo`, …) depends on THIS package —
 * not on the `sammy-pack` engine — so the surface adapters couple to is
 * tiny and slow-moving, while the engine stays free to change.
 *
 * It carries no broker SDK and (apart from `node:`-builtins) no runtime
 * dependency, which is what keeps adapters that depend on it lightweight.
 *
 * Today the SDK exposes the queue-source contract (the narrow waist for
 * pluggable message brokers) and the client-side request signer that
 * authenticates against a `"signed": true` trigger. The `sammy-pack`
 * engine re-exports everything here for back-compat, so existing
 * `import { httpDeliver, type QueueSource } from 'sammy-pack'` keeps
 * working unchanged.
 */

// ── Queue-source contract (the narrow waist) ───────────────────────
export {
  makeHttpDeliver,
  httpDeliver,
  type QueueSource,
  type SourceMessage,
  type DeliveryResult,
  type DeliverFn,
  type DeliverSigning,
  type HttpDeliverOptions,
} from './queue-source.js';

// ── Client-side request signing (the signing half of the trigger
//    ingress auth scheme; the verifier is server-only in the engine) ──
export { signWebhookBody, signWebhookBodyV2 } from './signing.js';
