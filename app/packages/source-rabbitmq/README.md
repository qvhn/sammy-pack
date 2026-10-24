# @sammy-pack/source-rabbitmq

An **optional** RabbitMQ (AMQP 0-9-1) queue-source adapter for
[sammy-pack](https://www.npmjs.com/package/sammy-pack).

It consumes a RabbitMQ queue and delivers each message to a sammy-pack
`queue` trigger over HTTP, **acking only after a `2xx`** and **nacking**
otherwise. Combined with sammy-pack's durable, Postgres-backed delivery
queue, that's **at-least-once** delivery end-to-end — and `amqplib` lives
in *this* package, never in the sammy-pack core.

## Why a separate package?

sammy-pack's core depends on exactly one thing about your queues: *"a
message arrived → start a run with it as input."* That contract is the
HTTP `queue` trigger (`POST /api/queue/<queue>`). Every broker is an
**adapter** on the far side of that narrow waist — so Rabbit, SQS, Kafka,
etc. are optional add-ons you install only if you need them. The core never
grows a broker dependency.

## Install

```sh
npm i @sammy-pack/source-rabbitmq   # brings its own amqplib
```

`@sammy-pack/sdk` is a peer dependency (it provides the `httpDeliver`
contract).

## Run it (out-of-process — the default)

```sh
sammy-source-rabbitmq \
  --url         "$RABBIT_URL" \   # amqp://user:pass@host:5672/vhost
  --queue       orders \
  --deliver-to  orders-trigger \
  --base-url    http://localhost:5173 \
  [--prefetch 10] \
  --secret      "$SAMMY_WEBHOOK_SECRET"   # omit for an unsigned trigger
```

The matching trigger on your orchestration:

```jsonc
{ "kind": "queue", "queue": "orders-trigger", "signed": true }
```

Pass the AMQP URL via env (`--url "$RABBIT_URL"`) so the broker credentials
aren't visible in the process list.

## Or embed it

```ts
import { startRabbitSource } from '@sammy-pack/source-rabbitmq';

const ac = new AbortController();
await startRabbitSource({
  url: process.env.RABBIT_URL!,
  queue: 'orders',
  deliverTo: 'orders-trigger',
  baseUrl: 'http://localhost:5173',
  prefetch: 10,
  signing: { secret: process.env.SAMMY_WEBHOOK_SECRET! }, // optional
  signal: ac.signal,
});
```

## Reliability model

```
Rabbit ──deliver──▶ adapter ──POST /api/queue/<q>──▶ sammy-pack
                      │                                  │
                      │            2xx (durably recorded)│
                      ◀──────────────────────────────────┘
                      │
            ack / nack(requeue) / nack(→DLX) by result
```

- **2xx** (`202` / `200`) → durably owned by the core → `channel.ack`.
- **retryable** (`5xx` / `429` / transport error) → `channel.nack(requeue:
  true)` → the broker redelivers.
- **non-retryable** (`401` / `404` / other `4xx`, i.e. poison) →
  `channel.nack(requeue: false)` → the message goes to the queue's
  **dead-letter exchange** instead of hot-looping. It is *not* silently
  dropped — set up a DLX to inspect poison messages.
- A publisher-set `messageId` is sent as the `Idempotency-Key`, so a
  redelivery collapses to one run.

Set a dead-letter exchange on the consumed queue
(`x-dead-letter-exchange`) so non-retryable failures land somewhere
inspectable.

## Add any broker in ~50 lines

This adapter follows the same template as
[`@sammy-pack/source-sqs`](https://www.npmjs.com/package/@sammy-pack/source-sqs)
and [`-kafka`](https://www.npmjs.com/package/@sammy-pack/source-kafka): a
broker-agnostic loop (`rabbit-source.ts`) driven against a **minimal
injected channel surface** (`RabbitChannelLike`), so it's unit-testable
with a mock and no `amqplib` installed; the real channel is wired in only
at the package's `index.ts` / CLI edge. Implement the `QueueSource`
contract from [`@sammy-pack/sdk`](https://www.npmjs.com/package/@sammy-pack/sdk)
and reuse the shared deliver/ack/idempotency/signing machinery.

See [`docs/PLUGGABLE_QUEUE_SOURCES.md`](https://github.com/qvhn/sammy-pack/blob/main/docs/PLUGGABLE_QUEUE_SOURCES.md)
for the full design, and [`@sammy-pack/queue-service`](https://www.npmjs.com/package/@sammy-pack/queue-service)
to host this adapter from a declarative `sources` binding.
