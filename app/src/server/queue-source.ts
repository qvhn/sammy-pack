/**
 * Queue-source contract — re-export shim.
 *
 * The contract itself now lives in `@sammy-pack/sdk` (the small, stable
 * public boundary third-party broker adapters depend on). This module
 * stays as a re-export so existing engine-internal imports
 * (`./queue-source`) and the `sammy-pack` package's re-export keep working
 * unchanged — see `app/packages/sdk/src/queue-source.ts` for the source of
 * truth, the reliability model, and the full doc comment.
 *
 * Keeping this shim means moving the contract into the SDK was a pure
 * relocation: no call site in the engine had to change, and the public
 * `import { httpDeliver, type QueueSource } from 'sammy-pack'` surface is
 * identical.
 */

export {
  makeHttpDeliver,
  httpDeliver,
  type QueueSource,
  type SourceMessage,
  type DeliveryResult,
  type DeliverFn,
  type DeliverSigning,
  type HttpDeliverOptions,
} from '@sammy-pack/sdk';
