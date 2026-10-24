# ADR: Pluggable queue sources (broker adapters behind the `queue` trigger)

- **Status:** Accepted — contract extracted to `@sammy-pack/sdk`; SQS,
  Kafka, and RabbitMQ adapters shipped; `@sammy-pack/queue-service`
  connector runtime shipped; trigger-kind registry landed for the pure
  dispatch points (validation + describe).
- **Scope:** how messages from external brokers (SQS, Kafka, RabbitMQ,
  Pub/Sub, Redis streams, …) become sammy-pack runs, **without the core
  engine ever depending on a broker client.**
- **See also:** [`triggers.md`](triggers.md) (the trigger system),
  [`architecture.md`](architecture.md) (durable runs),
  [`deployment.md`](deployment.md) (standalone workers + env).

## Context

sammy-pack already has a `queue` trigger: declare
`{ "kind": "queue", "queue": "<name>" }` on an orchestration and a message
delivered to `POST /api/queue/<name>` starts a run with the message body as
its initial input. Ingress is durable — the request is recorded in a
Postgres-backed delivery queue and acknowledged **before** any run exists; a
worker then claims the delivery and starts the run (accept ≠ execute). The
core ships with **no broker client** — no `kafkajs`, no `@aws-sdk/*`, no
`amqplib` — and keeping it that way is a hard requirement: it's what lets
the engine stay small, provider-neutral, and cheap to embed.

What's missing is the other half: most queues in the wild are not "something
that does an HTTP POST." They are SQS queues, Kafka topics, Rabbit
exchanges. We need a way to pull from those brokers and feed the `queue`
trigger — *as an optional add-on*, never as core weight.

## Decision

Adopt a **ports & adapters / narrow-waist** design.

> The core depends on exactly ONE contract: **"a message arrived → start a
> run with it as input."** That contract is the HTTP `queue` trigger. Every
> broker is an **adapter** that sits on the FAR side of that contract and is
> NEVER a dependency of the core.

HTTP delivery to `POST /api/queue/<queue>` **is the narrow waist.** Anything
that can make that call — a curl one-liner, a Lambda, a Kafka consumer, an
SQS poller — is a valid producer. Broker adapters are just well-behaved
producers that also know how to *acknowledge their broker correctly*.

### Two axes — keep them separate

A persistent source of confusion is conflating *how a run starts* with
*where a queue message came from*. They are different layers:

| Axis | Question | Examples | Owned by |
| --- | --- | --- | --- |
| **(1) trigger KINDS** | *How* does a run start? | `webhook`, `cron`, `queue`, `events`, `polling`, `deployment` | the **core / server** |
| **(2) queue SOURCES** | *Where* did a `queue` message come from? | `sqs`, `kafka`, `rabbit`, `pubsub`, `redis-streams` | **optional adapters**, a layer **under** the `queue` kind |

```
                         the narrow waist
                               │
  broker world                 │            sammy-pack core
  ───────────────              ▼            ─────────────────
  ┌────────┐   ┌──────────────────────────┐   ┌───────────────┐
  │  SQS   │──▶│ source-sqs   ─┐           │   │ queue trigger │
  ├────────┤   ├──────────────┤ httpDeliver│──▶│ POST /api/    │──▶ durable
  │ Kafka  │──▶│ source-kafka ─┤ (HTTP POST)│   │   queue/<q>   │   delivery
  ├────────┤   ├──────────────┤           │   └───────────────┘   queue → run
  │ Rabbit │──▶│ source-rabbit ┘           │        (axis 1)
  └────────┘   └──────────────────────────┘
   (axis 2: queue SOURCES — optional, out-of-process)
```

Axis (1) lives in the server and is a closed, curated set. Axis (2) is
open-ended and lives in **optional packages** the core knows nothing about.
A source's only job is: pull from its broker, call the narrow waist, and ack
its broker correctly.

### The Source contract

A tiny TypeScript contract, shipped from the dedicated
[`@sammy-pack/sdk`](../app/packages/sdk) package so adapter packages import
it (`import { httpDeliver, type QueueSource } from '@sammy-pack/sdk'`) — the
public boundary third-party adapters depend on, kept separate from the
engine so the engine is free to evolve behind it (see **Distribution
model** below). It carries **no broker SDK** and (apart from
`node:`-builtins) **no runtime dependency** — just the queue-source contract
+ the client-side trigger signer. The `sammy-pack` engine re-exports it
(via [`app/src/server/queue-source.ts`](../app/src/server/queue-source.ts)),
so the legacy `import … from 'sammy-pack'` keeps working unchanged.

```ts
/** One message pulled from a broker, normalized for the narrow waist. The
 *  broker-native ack handle stays INSIDE the adapter. */
interface SourceMessage {
  body: string;            // becomes the run's initial input, verbatim
  idempotencyKey?: string; // → Idempotency-Key header (dedupe redeliveries)
}

/** ok iff the queue trigger answered 2xx — the ONLY case in which the
 *  adapter may ack its broker. */
type DeliveryResult =
  | { ok: true;  status: number; duplicate: boolean }
  | { ok: false; status: number; retryable: boolean; error: string };

type DeliverFn = (msg: SourceMessage) => Promise<DeliveryResult>;

/** A broker adapter: an abortable consume-loop. */
interface QueueSource {
  readonly kind: string; // "sqs" | "kafka" | …
  start(opts: { deliver: DeliverFn; signal: AbortSignal }): Promise<void>;
}
```

Plus a shared `makeHttpDeliver(opts) → DeliverFn` (and a one-shot
`httpDeliver`) that POSTs to `/api/queue/<queue>`, applies optional HMAC
signing, and classifies the response into a `DeliveryResult`. Crucially, it
**reuses the existing webhook-auth signer** (`signWebhookBody` /
`signWebhookBodyV2`) — the signing scheme is defined in exactly one place
([`webhook-auth.ts`](../app/src/server/webhook-auth.ts)), never duplicated
in an adapter.

### Reliability model — at-least-once without a broker client in core

The contract pins one rule, and the whole guarantee follows from it:

> An adapter ACKs its broker (SQS `DeleteMessage` / Kafka commit / Rabbit
> `ack`) **only after `deliver()` returns `{ ok: true }`** — i.e. the queue
> trigger answered `2xx`.

A `2xx` from the narrow waist means the delivery is **durably recorded** in
sammy-pack's Postgres-backed delivery queue, so it *will* become a run even
if the server restarts before the worker picks it up. Therefore:

- **2xx** (`202` accepted, or `200` for an idempotent redelivery) → the core
  owns the message durably → the adapter acks the broker.
- **non-2xx or transport error** → nothing durable was recorded → the
  adapter does **not** ack → the broker redelivers (visibility-timeout
  expiry / un-committed offset / re-queued message).

End-to-end this is **at-least-once**, with the durability boundary owned by
the core — not by the adapter, and not by a broker SDK linked into the core.
The `Idempotency-Key` (the broker's message id) makes the inevitable
redelivery collapse to a single run, so at-least-once doesn't mean
duplicate work in practice.

Status-code handling in `httpDeliver`:

| Response | `ok` | `retryable` | Adapter behaviour |
| --- | --- | --- | --- |
| `202` / `200` | ✅ | — | **ack** (durably accepted) |
| `429` (queue full / backpressure) | ❌ | yes | leave un-acked → redeliver |
| `5xx` (server transient) | ❌ | yes | leave un-acked → redeliver |
| `401` (bad signature) / `404` (no such queue trigger) / other `4xx` | ❌ | no | leave un-acked (a poison message is **not** silently dropped — it surfaces via the broker's own redelivery/DLQ) |
| transport error / timeout | ❌ | yes | leave un-acked → redeliver |

### Deployment — out-of-process by default

Adapters run as their **own process** by default (a standalone runner /
CLI). Rationale:

- **Blast-radius isolation** — broker flakiness, SDK memory growth, a
  throttling storm: none of it touches the orchestration server. The
  adapter only holds an HTTP client.
- **Independent scaling & placement** — run the adapter as a sidecar, on a
  separate host, in a CronJob, or N replicas. With Postgres, the delivery
  queue already de-duplicates and claims with `FOR UPDATE SKIP LOCKED`, so
  multiple adapter instances are safe.
- **No new core surface** — the server doesn't grow a plugin loader or
  broker lifecycle; it keeps doing the one thing it does.

The contract *also* permits an optional **in-process connector-runner**
later (a `QueueSource[]` the server starts in-band for low-ceremony local
dev). That's an additive convenience, not the default, and it would still
go through the same `httpDeliver` waist — so it changes nothing about the
reliability model.

### Reference adapters — SQS, Kafka, RabbitMQ

Each is shipped as an **optional package** that declares its broker client
as **its own dependency** (never the core's) and `@sammy-pack/sdk` as a peer
(for the contract). Every one follows the same shape: a tiny broker-specific
consume loop written against a **minimal injected client surface**, so it's
unit-testable with a mock and **no broker SDK installed**; the real client
is wired in only at the package's `index.ts` / CLI edge.

| Package | Broker dep | Ack semantics | CLI |
| --- | --- | --- | --- |
| [`@sammy-pack/source-sqs`](../app/packages/source-sqs) | `@aws-sdk/client-sqs` | long-poll → deliver → `DeleteMessage` iff 2xx | `sammy-source-sqs` |
| [`@sammy-pack/source-kafka`](../app/packages/source-kafka) | `kafkajs` | subscribe (auto-commit off) → deliver → `commitOffsets(offset+1)` iff 2xx; else pause partition | `sammy-source-kafka` |
| [`@sammy-pack/source-rabbitmq`](../app/packages/source-rabbitmq) | `amqplib` | consume → deliver → `ack` iff 2xx / `nack(requeue)` if retryable / `nack(→DLX)` if poison | `sammy-source-rabbitmq` |

Run any of them out-of-process, e.g.:

```sh
sammy-source-sqs \
  --queue-url   https://sqs.<region>.amazonaws.com/<acct>/<queue> \
  --deliver-to  <queue-trigger-name> \
  --base-url    http://localhost:5173 \
  [--region <r>] [--secret <hmac>] [--sig-scheme v2|v1]
```

See each package README for the "**add any broker in ~50 lines**" template —
implement the two methods the loop needs (receive/ack-equivalent) and reuse
the shared deliver/ack/idempotency/signing machinery from `@sammy-pack/sdk`.

## Distribution model — the `@sammy-pack/*` package family

The ports-&-adapters design maps directly onto a package family, so the
"narrow waist" is also a **dependency boundary** on npm:

```
                @sammy-pack/sdk          ← the keystone: contract + signer,
                 (the public                no broker SDK, ~zero deps. STABLE.
                  boundary)
                  ▲   ▲   ▲
        ┌─────────┘   │   └───────────────────────────┐
        │             │                               │
  sammy-pack     @sammy-pack/source-*          @sammy-pack/queue-service
  (the engine,   (one per broker, each          (broker-agnostic connector
   re-exports     brings ITS OWN broker          runtime; hosts adapters
   the SDK for    SDK as a dep)                  from a `sources` binding;
   back-compat)   sqs · kafka · rabbitmq         depends on the SDK only)
                  ▲
                  │  (same contract)
        @their-org/sammy-source-foo
        (third-party adapters — depend on @sammy-pack/sdk, not the engine)
```

- **`@sammy-pack/sdk` is the keystone.** It is the *only* thing a broker
  adapter couples to: the `QueueSource` contract, `makeHttpDeliver`, and the
  client-side trigger signer. It carries no broker SDK and ~no runtime
  dependency, so it is tiny and slow-moving — adapters pin a stable surface
  while the engine changes freely. The engine re-exports it, so existing
  `import … from 'sammy-pack'` is unaffected.
- **Per-broker `@sammy-pack/source-*` packages.** One optional package per
  broker, each declaring *its own* broker client as a dependency. The core
  never grows a broker dep; a user installs only the adapters they use. A
  broken/abandoned adapter can't destabilise the core or the other adapters.
- **`@sammy-pack/queue-service` is the connector runtime.** A
  broker-agnostic host that runs registered `QueueSource` adapters from a
  declarative `sources` binding (next section). It depends on the SDK only;
  the adapters a user registers are the only thing that pull a broker SDK
  in. It is the managed alternative to launching each adapter's own CLI.
- **The `@sammy-pack/*` scope is reserved** (npm org `sammy-pack`), so the
  first-party family (`sdk`, `cli`, `queue-service`, `source-sqs`,
  `source-kafka`, `source-rabbitmq`, …) has a stable, squat-proof home.
- **Third-party adapters are first-class.** Anyone can publish
  `@their-org/sammy-source-<broker>` (or any name) that depends on
  `@sammy-pack/sdk`, implements `QueueSource`, and is hosted by
  `queue-service` via explicit registration — without any change to, or
  blessing from, the core. The convention `sammy-source-*` makes them
  greppable on npm; the SDK dependency is what actually makes them work.

## Roadmap — declarative `sources` binding

An adapter can be launched as a process with flags (the `source-*` CLIs).
The declarative, discoverable binding — now implemented by
[`@sammy-pack/queue-service`](../app/packages/queue-service) — reuses
infrastructure that already exists:

1. **`sources` on the workspace.** Add an optional `sources` array to the
   `Workspace` type — each entry binds a broker to a `queue` trigger:

   ```jsonc
   {
     "name": "my-workspace",
     "sources": [
       {
         "source": "sqs",
         "queueUrl": "https://sqs.us-east-1.amazonaws.com/123/my-q",
         "region": "us-east-1",
         "credentialRef": "aws-prod",   // ← see (2)
         "deliversTo": "my-queue-trigger"
       }
     ]
   }
   ```

   `deliversTo` must name a declared `queue` trigger; validation can check
   that and surface a clear error otherwise.

2. **Broker secrets via the existing credential registry.** The
   credentials registry ([`credentials-store.ts`](../app/src/server/credentials-store.ts))
   **already has an `aws` credential kind.** `credentialRef` resolves a
   named entry, so broker creds live in the registry (env-overridable),
   never in committed orchestration/workspace JSON — exactly as
   provider keys and the `SAMMY_WEBHOOK_SECRET` already work.

3. **Triggers UI shows bound sources.** The Triggers page already lists
   every registered trigger; once `sources` exist, a `queue` trigger can
   render its bound source(s) ("← SQS my-q") so the path from broker to run
   is visible in one place.

4. **A `sources`-aware runner — DONE** via
   [`@sammy-pack/queue-service`](../app/packages/queue-service). Its
   `sammy-queue-service --config <workspace.json>` reads the `sources`
   array, resolves each `credentialRef` from the credential registry, and
   hosts the matching adapter's consume loop (out-of-process per binding by
   default; the same runtime is embeddable in-process). It composes — it
   does not replace the raw `source-*` CLIs, which stay the lowest-level
   entry point. The binding shape it consumes is exactly the `sources`
   entry in (1): `{ source, ...config, credentialRef, deliversTo }`.
   Adapters are registered **explicitly** today (install the `source-*`
   package + register/reference it); auto-discovery (scan `node_modules`
   for `@sammy-pack/source-*`) is a deliberate follow-on so a stray
   installed package can't silently start consuming.

Still open from this list: wiring `sources` onto the `Workspace` type with
validation that `deliversTo` names a declared `queue` trigger (1), and the
Triggers-UI "← bound source" surfacing (3). The connector runtime (4) reads
a `sources` array from any config JSON today, so those are additive.

None of this changes the contract or the reliability model: a declared
source is just a managed way to start a `QueueSource` that calls the same
`httpDeliver` waist — `queue-service` adds **no new reliability surface**.

## Related (separable) — the trigger-kind registry

This ADR is about **axis (2)** (sources under the `queue` kind). A clean,
*independent* improvement on **axis (1)** — making new trigger KINDS
additive — has now **partially landed**, recorded here so the two axes
aren't conflated.

A trigger kind was historically dispatched with a `switch`/`if-else` over
`t.kind` (`webhook` / `cron` / `events` / `deployment` / `queue` /
`polling`) at **three** points: declaration **validation**
([`validate.ts`](../app/src/validate.ts)), a **describe** summary
(`sammy-pack-api.ts`), and the server's **register/listen** wiring
(`sammy-pack-api.ts`). Adding a kind meant editing all three.

**Built:** the two *pure* dispatch points are now data-driven via a
trigger-kind registry, [`src/trigger-kinds.ts`](../app/src/trigger-kinds.ts).
Each kind is one entry — `{ kind, fired, describe(t), validate(t) }`:
`validate.ts` and the server's `describeTrigger` look the kind up there, and
the "unknown kind" message is derived from the registry's key set so it
can't drift. `LIVE_TRIGGER_KINDS` ([`types.ts`](../app/src/types.ts)) is the
set the registry is type-checked to cover exactly. Adding a kind's **shape +
summary + validation** is now a single additive entry.

**Deliberately deferred:** the **register/listen** wiring (point 3) stays a
`switch`. It is tightly bound to the server's request-scoped closure state —
the per-orch trigger maps, `deliver()`, the node-cron task registry, polling
timers, the HTTP-fired named-trigger middlewares, the catalog — and folding
that into the registry now would be invasive and risky for little
additional payoff. The `fired: 'http' | 'schedule'` field on each descriptor
records which dispatch half a kind lives on, so that extraction is a
mechanical follow-on when it's worth doing. This is the
"scope-it-down-and-document-the-seam" call: the additive win (validation +
metadata) is captured; the delicate lifecycle wiring is left intact.

"Make new *kinds* additive" and "make new *sources* additive" are the same
instinct applied to the two different axes — and keeping them mentally
separate is the whole point of this document.

## Consequences

- **The core stays broker-free.** The only thing that lands in core is the
  contract + `httpDeliver` (HTTP + HMAC, both already present). Brokers live
  in optional packages.
- **New brokers are cheap and isolated.** ~50 lines + a `package.json` with
  that broker's SDK. A broken/abandoned adapter can't destabilise the core.
- **One reliability story, everywhere.** Every adapter inherits
  at-least-once-with-idempotency by obeying one rule (ack iff 2xx); they
  can't each invent their own.
- **One signing story.** Adapters reuse the SDK's client signer (which the
  engine's verifier imports); the HMAC scheme is defined once and never
  re-implemented per adapter.
- **A stable public boundary.** `@sammy-pack/sdk` is the small, slow-moving
  surface adapters pin; the engine evolves behind it. Third parties publish
  `@their-org/sammy-source-*` against the SDK with no core change — the
  reserved `@sammy-pack/*` scope keeps the first-party family squat-proof.
- **Operability is opt-in.** Out-of-process by default; the
  `@sammy-pack/queue-service` connector runtime (declarative `sources`
  binding) is a managed convenience, not a prerequisite — the raw `source-*`
  CLIs remain the lowest-level entry point.
