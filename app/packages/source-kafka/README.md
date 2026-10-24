# @sammy-pack/source-kafka

An **optional** Apache Kafka queue-source adapter for
[sammy-pack](https://www.npmjs.com/package/sammy-pack).

It subscribes to a Kafka topic and delivers each record to a sammy-pack
`queue` trigger over HTTP, **committing the offset (the ack) only after a
`2xx`**. Combined with sammy-pack's durable, Postgres-backed delivery
queue, that's **at-least-once** delivery end-to-end — and `kafkajs` lives
in *this* package, never in the sammy-pack core.

## Why a separate package?

sammy-pack's core depends on exactly one thing about your queues: *"a
message arrived → start a run with it as input."* That contract is the
HTTP `queue` trigger (`POST /api/queue/<queue>`). Every broker is an
**adapter** on the far side of that narrow waist — so Kafka, SQS, Rabbit,
etc. are optional add-ons you install only if you need them. The core never
grows a broker dependency.

## Install

```sh
npm i @sammy-pack/source-kafka   # brings its own kafkajs
```

`@sammy-pack/sdk` is a peer dependency (it provides the `httpDeliver`
contract).

## Run it (out-of-process — the default)

```sh
sammy-source-kafka \
  --brokers     broker-1:9092,broker-2:9092 \
  --topic       orders \
  --deliver-to  orders-trigger \
  --base-url    http://localhost:5173 \
  --group-id    sammy-pack \
  [--from-beginning] \
  --secret      "$SAMMY_WEBHOOK_SECRET"   # omit for an unsigned trigger
```

The matching trigger on your orchestration:

```jsonc
{ "kind": "queue", "queue": "orders-trigger", "signed": true }
```

## Or embed it

```ts
import { startKafkaSource } from '@sammy-pack/source-kafka';

const ac = new AbortController();
await startKafkaSource({
  brokers: ['broker-1:9092'],
  topic: 'orders',
  groupId: 'sammy-pack',
  deliverTo: 'orders-trigger',
  baseUrl: 'http://localhost:5173',
  signing: { secret: process.env.SAMMY_WEBHOOK_SECRET! }, // optional
  kafka: { ssl: true /* sasl: {...} */ },                  // extra kafkajs config
  signal: ac.signal,
});
```

## Reliability model

```
Kafka ──record──▶ adapter ──POST /api/queue/<q>──▶ sammy-pack
                    │                                  │
                    │            2xx (durably recorded)│
                    ◀──────────────────────────────────┘
                    │
            commitOffsets(offset+1) (ack) — ONLY on 2xx
```

- The consumer runs with **auto-commit OFF**; the adapter commits
  `offset + 1` (the next offset to read) **only** after a `2xx`.
- On a non-`2xx` (or transport error) the adapter commits nothing and
  **pauses the partition**, so it doesn't read past the un-acked record —
  it is re-consumed on resume / the next run.
- The record's `${topic}-${partition}-${offset}` is sent as the
  `Idempotency-Key`, so a re-consume (after a pause or a rebalance)
  collapses to one run instead of duplicating work.

## Add any broker in ~50 lines

This adapter follows the same template as
[`@sammy-pack/source-sqs`](https://www.npmjs.com/package/@sammy-pack/source-sqs):
a broker-agnostic loop (`kafka-source.ts`) driven against a **minimal
injected consumer surface** (`KafkaConsumerLike`), so it's unit-testable
with a mock and no `kafkajs` installed; the real consumer is wired in only
at the package's `index.ts` / CLI edge. Implement the `QueueSource`
contract from [`@sammy-pack/sdk`](https://www.npmjs.com/package/@sammy-pack/sdk)
and reuse the shared deliver/ack/idempotency/signing machinery.

See [`docs/PLUGGABLE_QUEUE_SOURCES.md`](https://github.com/qvhn/sammy-pack/blob/main/docs/PLUGGABLE_QUEUE_SOURCES.md)
for the full design, and [`@sammy-pack/queue-service`](https://www.npmjs.com/package/@sammy-pack/queue-service)
to host this adapter from a declarative `sources` binding.
