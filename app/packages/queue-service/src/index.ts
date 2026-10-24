/**
 * @sammy-pack/queue-service — a broker-agnostic connector runtime.
 *
 * Hosts registered `QueueSource` adapters and manages their consume-loop
 * lifecycle from a declarative `sources` binding
 * (`[{ source, ...config, credentialRef, deliversTo }]`), resolving broker
 * secrets through the credential registry. It depends on `@sammy-pack/sdk`
 * ONLY — never a broker SDK; the adapters a host registers are the only
 * thing that pull broker clients in.
 *
 *   import { QueueService, SourceRegistry } from '@sammy-pack/queue-service';
 *   import { startSqsSource } from '@sammy-pack/source-sqs';
 *
 *   const registry = new SourceRegistry().register('sqs', async ({
 *     config, deliversTo, baseUrl, signingSecret,
 *   }) => ({
 *     kind: 'sqs',
 *     start: ({ signal }) => startSqsSource({
 *       queueUrl: config.queueUrl as string,
 *       deliverTo: deliversTo,
 *       baseUrl,
 *       signing: signingSecret ? { secret: signingSecret } : undefined,
 *       signal,
 *     }),
 *   }));
 *
 *   const svc = new QueueService({
 *     registry,
 *     bindings: workspace.sources,
 *     baseUrl: 'http://localhost:5173',
 *     credentialResolver: defaultFileCredentialResolver(),
 *     signingSecret: process.env.SAMMY_WEBHOOK_SECRET,
 *   });
 *   await svc.start();
 */

export { QueueService, validateBindings, type QueueServiceOptions } from './runtime.js';
export { SourceRegistry, createRegistry } from './registry.js';
export {
  defaultFileCredentialResolver,
  resolveCredentialsFile,
} from './credentials.js';
export type {
  SourceBinding,
  SourceFactory,
  CredentialResolver,
  ResolvedCredential,
  ConnectorState,
  ConnectorStatus,
} from './types.js';
