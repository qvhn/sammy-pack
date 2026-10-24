# @sammy-pack/sdk

The small, **stable public contract** for building
[sammy-pack](https://www.npmjs.com/package/sammy-pack) integrations —
chiefly **queue-source adapters** that connect an external broker (SQS,
Kafka, RabbitMQ, Pub/Sub, Redis streams, …) to a sammy-pack `queue`
trigger.

It carries **no broker SDK** and (apart from `node:`-builtins) **no
runtime dependency**. That is the point: an adapter couples to this tiny,
slow-moving surface, not to the `sammy-pack` engine — so the engine stays
free to evolve and your adapter stays lightweight.

## Why this package exists

sammy-pack's core depends on exactly one thing about your queues: *"a
message arrived → start a run with it as input."* That contract is the
HTTP `queue` trigger (`POST /api/queue/<queue>`) — the **narrow waist**.
Every broker is an **adapter** on the far side of that waist.

This SDK ships the contract for writing those adapters:

- `QueueSource` — an abortable consume-loop interface.
- `SourceMessage` / `DeliveryResult` / `DeliverFn` — the types the loop
  pulls and gets back.
- `makeHttpDeliver(opts)` / `httpDeliver(msg, opts)` — the shared call
  that POSTs to `/api/queue/<queue>`, applies optional HMAC signing, and
  classifies the response (`2xx` → ok → ack your broker; anything else →
  leave un-acked → redeliver).
- `signWebhookBody` / `signWebhookBodyV2` — the client-side signer for a
  `"signed": true` trigger (the verifying half lives in the engine).

The `sammy-pack` engine **re-exports everything here**, so existing
`import { httpDeliver, type QueueSource } from 'sammy-pack'` keeps working
— but new adapters should depend on `@sammy-pack/sdk` directly to sit on
the public boundary.

## Install

```sh
npm i @sammy-pack/sdk
```

No peer dependency, no broker SDK — bring your own broker client in your
adapter package.

## Write an adapter

```ts
import {
  makeHttpDeliver,
  type QueueSource,
  type DeliverFn,
} from '@sammy-pack/sdk';

class MyBrokerSource implements QueueSource {
  readonly kind = 'my-broker';
  constructor(private readonly broker: MyBrokerClient) {}

  async start({ deliver, signal }: { deliver: DeliverFn; signal: AbortSignal }) {
    while (!signal.aborted) {
      const msgs = await this.broker.poll();          // your pull
      for (const m of msgs) {
        if (signal.aborted) break;
        const result = await deliver({
          body: m.payload,                            // → run input
          idempotencyKey: m.id,                       // → dedupe redeliveries
        });
        if (result.ok) await this.broker.ack(m.handle); // ack ONLY on 2xx
        // else: leave un-acked → the broker redelivers
      }
    }
  }
}
```

Wire it to a server and run it out-of-process:

```ts
const deliver = makeHttpDeliver({
  baseUrl: 'http://localhost:5173',
  queue: 'my-queue-trigger',
  signing: { secret: process.env.SAMMY_WEBHOOK_SECRET! }, // optional
});

const ac = new AbortController();
await new MyBrokerSource(broker).start({ deliver, signal: ac.signal });
```

## The reliability rule (inherited by every adapter)

> **Ack your broker only after `deliver()` returns `{ ok: true }`** — i.e.
> the queue trigger answered `2xx`.

A `2xx` means the delivery is durably recorded in sammy-pack's
Postgres-backed delivery queue, so it *will* become a run even across a
server restart. Send the broker's message id as the `idempotencyKey` and
the inevitable redelivery collapses to one run. This gives you
**at-least-once** end-to-end, with the durability boundary owned by the
core — and no broker SDK anywhere near it.

| Response | `ok` | Adapter behaviour |
| --- | --- | --- |
| `202` / `200` | yes | **ack** (durably accepted) |
| `429` / `5xx` / transport error | no (retryable) | leave un-acked → redeliver |
| `401` / `404` / other `4xx` | no (not retryable) | leave un-acked (poison message surfaces via your broker's DLQ) |

## Reference adapters

- [`@sammy-pack/source-sqs`](https://www.npmjs.com/package/@sammy-pack/source-sqs)
  — Amazon SQS
- [`@sammy-pack/source-kafka`](https://www.npmjs.com/package/@sammy-pack/source-kafka)
  — Apache Kafka
- [`@sammy-pack/source-rabbitmq`](https://www.npmjs.com/package/@sammy-pack/source-rabbitmq)
  — RabbitMQ

See [`docs/PLUGGABLE_QUEUE_SOURCES.md`](https://github.com/qvhn/sammy-pack/blob/main/docs/PLUGGABLE_QUEUE_SOURCES.md)
for the full design, including the `@sammy-pack/queue-service` connector
runtime and the third-party adapter ecosystem.
