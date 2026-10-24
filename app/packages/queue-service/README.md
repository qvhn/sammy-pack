# @sammy-pack/queue-service

A **broker-agnostic connector runtime** for
[sammy-pack](https://www.npmjs.com/package/sammy-pack) queue sources.

It hosts registered [`QueueSource`](https://www.npmjs.com/package/@sammy-pack/sdk)
adapters and manages their consume-loop lifecycle (start / stop /
`AbortSignal`) from a **declarative `sources` binding** — resolving broker
secrets through the sammy-pack credential registry.

It depends on [`@sammy-pack/sdk`](https://www.npmjs.com/package/@sammy-pack/sdk)
**only** — never a broker SDK. The adapters you register are the only thing
that pull a broker client in, so the runtime itself stays small and
broker-neutral.

## The `sources` binding

A `sources` array binds brokers to `queue` triggers. Each entry is
`{ source, ...config, credentialRef, deliversTo }`:

```jsonc
{
  "name": "my-workspace",
  "sources": [
    {
      "source": "sqs",                // a registered adapter
      "queueUrl": "https://sqs.us-east-1.amazonaws.com/123/my-q",
      "credentialRef": "aws-prod",    // a credential-registry entry
      "deliversTo": "my-queue-trigger" // a declared `queue` trigger
    },
    {
      "source": "kafka",
      "brokers": ["broker-1:9092", "broker-2:9092"],
      "topic": "orders",
      "groupId": "sammy",
      "deliversTo": "orders-trigger"
    }
  ]
}
```

- `source` selects a registered adapter factory.
- `deliversTo` names the `queue` trigger messages land at
  (`POST /api/queue/<deliversTo>`).
- `credentialRef` (optional) resolves a credential-registry entry whose
  fields configure the broker client — so broker creds live in the
  registry (env-overridable via `SAMMY_CONNECTIONS_FILE`), never in
  committed JSON. The registry already has an `aws` kind.
- every other key is adapter-specific config, passed through verbatim.

## Run it (CLI)

Install the runtime **plus the source adapters you reference**:

```sh
npm i @sammy-pack/queue-service @sammy-pack/source-sqs
```

```sh
sammy-queue-service \
  --config    ./workspace.json \
  --base-url  http://localhost:5173 \
  [--connections ./credentials.json]   # else SAMMY_CONNECTIONS_FILE / cwd
  [--secret      "$SAMMY_WEBHOOK_SECRET"]  # for signed queue triggers
  [--dry-run]                              # validate + resolve, don't start
```

The CLI ships shims for the first-party adapters (`sqs`, `kafka`,
`rabbitmq`). Each is **dynamically imported**, so an adapter you don't
reference is never loaded and is not a dependency of this package — install
only the ones your `sources` use. A `--dry-run` validates every binding and
confirms each referenced adapter is installed, without starting any loop.

## Or embed it

Register adapters explicitly and host them yourself:

```ts
import {
  QueueService,
  SourceRegistry,
  defaultFileCredentialResolver,
} from '@sammy-pack/queue-service';
import { startSqsSource } from '@sammy-pack/source-sqs';

const registry = new SourceRegistry().register(
  'sqs',
  ({ config, credential, deliversTo, baseUrl, signingSecret }) => ({
    kind: 'sqs',
    start: ({ signal }) =>
      startSqsSource({
        queueUrl: config.queueUrl as string,
        region: (config.region as string) ?? credential?.fields?.region,
        deliverTo: deliversTo,
        baseUrl,
        signing: signingSecret ? { secret: signingSecret } : undefined,
        signal,
      }),
  }),
);

const svc = new QueueService({
  registry,
  bindings: workspace.sources,
  baseUrl: 'http://localhost:5173',
  credentialResolver: defaultFileCredentialResolver(),
  signingSecret: process.env.SAMMY_WEBHOOK_SECRET,
});

const { started, failed } = await svc.start();
// … later:
await svc.stop(); // aborts every loop and awaits a clean shutdown
```

A binding whose factory throws (bad config) is marked `failed` and
**skipped** — it never aborts the other connectors. `svc.statuses()`
exposes each connector's lifecycle state.

## What it does NOT change

The runtime adds **no new reliability surface**. Every message still flows
through the same `httpDeliver` narrow waist, so the contract's rule is
unchanged: **an adapter acks its broker only after a `2xx`**. Hosting many
adapters in one process is purely an operational convenience over running
each adapter's own CLI — the durability boundary stays owned by the core.

## Credential resolution

By default `credentialRef` is resolved from the same `credentials.json` the
engine's registry writes (honoring `SAMMY_CONNECTIONS_FILE`), normalized to
the `{ value, kind, fields, extras }` an adapter needs. A host embedding the
runtime in-process can pass a `credentialResolver` backed directly by the
engine's `credentials-store.ts` to inherit owner / orchestration scoping.

## Explicit registration today; auto-discovery later

Adapters are registered **explicitly** (install the `source-*` package +
reference it / register its factory). Auto-discovery — scanning
`node_modules` for `@sammy-pack/source-*` packages (or a
`package.json#sammyPack` marker) and self-registering — is a deliberate
**follow-on**, kept out of this milestone so the runtime's behaviour stays
predictable and a stray installed package can't silently start consuming.

See [`docs/PLUGGABLE_QUEUE_SOURCES.md`](https://github.com/qvhn/sammy-pack/blob/main/docs/PLUGGABLE_QUEUE_SOURCES.md)
for the full design and the adapter ecosystem.
