# @sammy-pack/source-sqs

An **optional** Amazon SQS queue-source adapter for
[sammy-pack](https://www.npmjs.com/package/sammy-pack).

It long-polls an SQS queue and delivers each message to a sammy-pack
`queue` trigger over HTTP, **acking the broker (DeleteMessage) only after a
`2xx`**. Combined with sammy-pack's durable, Postgres-backed delivery
queue, that's **at-least-once** delivery end-to-end — and the AWS SDK lives
in *this* package, never in the sammy-pack core.

## Why a separate package?

sammy-pack's core depends on exactly one thing about your queues: *"a
message arrived → start a run with it as input."* That contract is the
HTTP `queue` trigger (`POST /api/queue/<queue>`). Every broker is an
**adapter** on the far side of that narrow waist — so SQS, Kafka, Rabbit,
Pub/Sub, etc. are optional add-ons you install only if you need them. The
core never grows a broker dependency.

## Install

```sh
npm i @sammy-pack/source-sqs   # brings its own @aws-sdk/client-sqs
```

`sammy-pack` is a peer dependency (it provides the `httpDeliver` contract).

## Run it (out-of-process — the default)

Run the adapter as its own process so broker flakiness never touches your
orchestration server. AWS credentials resolve via the standard SDK chain
(env vars / shared config / instance role) — never via flags.

```sh
sammy-source-sqs \
  --queue-url   https://sqs.us-east-1.amazonaws.com/123456789012/my-queue \
  --deliver-to  my-queue-trigger \
  --base-url    http://localhost:5173 \
  --region      us-east-1 \
  --secret      "$SAMMY_WEBHOOK_SECRET"   # omit for an unsigned trigger
```

The matching trigger on your orchestration:

```jsonc
{ "kind": "queue", "queue": "my-queue-trigger", "signed": true }
```

`--secret` (or `SAMMY_WEBHOOK_SECRET`) is required only when the trigger is
`"signed": true`; the adapter then sends a replay-protected
`X-Sammy-Signature` (`--sig-scheme v2`, the default).

## Or embed it

```ts
import { startSqsSource } from '@sammy-pack/source-sqs';

const ac = new AbortController();
await startSqsSource({
  queueUrl: process.env.QUEUE_URL!,
  deliverTo: 'my-queue-trigger',
  baseUrl: 'http://localhost:5173',
  region: 'us-east-1',
  signing: { secret: process.env.SAMMY_WEBHOOK_SECRET! }, // optional
  signal: ac.signal,
});
```

## Reliability model

```
SQS ──receive──▶ adapter ──POST /api/queue/<q>──▶ sammy-pack
                   │                                  │
                   │            2xx (durably recorded)│
                   ◀──────────────────────────────────┘
                   │
            DeleteMessage (ack) — ONLY on 2xx
```

- **2xx** (`202` accepted / `200` deduped) → the delivery is durably owned
  by the core → the adapter deletes the message.
- **non-2xx or a transport error** → the message is left in flight → SQS
  redelivers it after the visibility timeout.
- The SQS `MessageId` is sent as the `Idempotency-Key`, so a redelivery
  collapses to one run instead of duplicating work.

## Add any broker in ~50 lines

This adapter is the template. To support a new broker, implement the two
methods the loop needs and reuse everything else:

```ts
import { runSqsLoop, type SqsLike } from '@sammy-pack/source-sqs';
// (or implement the QueueSource contract from `sammy-pack` directly)

const myBroker: SqsLike = {
  async receive() {
    const msgs = await broker.poll();           // your broker's pull
    return msgs.map(m => ({
      messageId: m.id,                           // → Idempotency-Key
      receiptHandle: m.handle,                   // your ack token
      body: m.payload,                           // → run input
    }));
  },
  async deleteMessage(handle) {
    await broker.ack(handle);                     // your broker's ack
  },
};
```

Then drive it with `makeHttpDeliver` + `runSqsLoop` (or write a tiny
`QueueSource` of your own). The ack-only-on-2xx rule, the idempotency key,
HMAC signing, and the retry-on-redelivery behaviour all come for free from
the shared contract in `sammy-pack`.

See [`docs/PLUGGABLE_QUEUE_SOURCES.md`](https://github.com/qvhn/sammy-pack/blob/main/docs/PLUGGABLE_QUEUE_SOURCES.md)
for the full design.
