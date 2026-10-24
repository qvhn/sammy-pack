# Triggers — firing runs from the outside world

Runs don't have to be started by hand. An orchestration can declare
**triggers**; saving the file registers them automatically (and re-registers
on every save). The **Triggers** page lists every registered trigger and has a
test harness; the **Deliveries** page shows what each trigger has ingested.

## Declaring triggers

A top-level `triggers` array on the orchestration:

```jsonc
{
  "name": "bug-report-funnel",
  "triggers": [
    { "kind": "webhook", "path": "bug-report", "method": "POST" }
  ],
  "phases": [ ... ]
}
```

## The six trigger kinds

| Kind | Required fields | Fires when | Run input |
| --- | --- | --- | --- |
| `webhook` | `path` (+ optional `method`, `signed`) | `POST /api/triggers/<path>` (or GET if `method: "GET"`) | request body |
| `cron` | `expr` | 5-field cron expression, server-local time (`"0 9 * * *"` = daily 09:00) | empty |
| `polling` | `source`, `intervalSeconds` | the server fetches `source` each tick; a run starts when the response is non-empty **and changed** since the last tick (conditional GET with ETag / If-Modified-Since) | response body |
| `events` | `event` | a domain event is fired: `POST /api/events/<event>` — multiple orchestrations may subscribe to one event | event body |
| `queue` | `queue` | a message is delivered: `POST /api/queue/<queue>` | message body |
| `deployment` | `environment` | a deploy is reported: `POST /api/deploy/<environment>` (e.g. staging deployed → run the QA orchestration) | request body |

Shipped examples to crib from: `bug-report-funnel` and `incident-response`
(webhook), `nightly-eval-gate` (cron), `security-watch` (polling).

**Connecting a real broker to a `queue` trigger** (SQS, Kafka, Rabbit, …):
the core never links a broker client — instead an optional *queue-source
adapter* pulls from the broker and delivers to `POST /api/queue/<queue>`,
acking the broker only on a `2xx`. See
[`PLUGGABLE_QUEUE_SOURCES.md`](PLUGGABLE_QUEUE_SOURCES.md) and the reference
adapter `@sammy-pack/source-sqs`.

## Signed ingress (webhook, events, queue, deployment)

Every HTTP-fired trigger kind accepts `"signed": true`. Export
`SAMMY_WEBHOOK_SECRET` in the server's environment; the caller must then send
a valid `X-Sammy-Signature` header or be rejected `401` (constant-time
comparison). The secret never lives in committed JSON. For shared names
(several orchestrations subscribed to one event), **strictest wins** — if any
subscriber demands a signature, the endpoint requires one.

Two header formats are accepted:

- **v2 (preferred — replay-protected):**
  `t=<unix-seconds>,n=<nonce>,v1=<hex>` where `<hex>` is
  HMAC-SHA256(`"<t>.<n>.<raw body>"`, secret). The timestamp must be within
  ±300 s of server time, and a nonce is rejected on reuse — so a captured
  request can't be replayed. `n` is optional (sign `"<t>..<body>"`), but
  include it: the timestamp bounds the replay window, the nonce closes it.

  ```bash
  T=$(date +%s); N=$(uuidgen)
  SIG=$(printf '%s.%s.%s' "$T" "$N" "$BODY" \
        | openssl dgst -sha256 -hmac "$SAMMY_WEBHOOK_SECRET" -hex | awk '{print $NF}')
  curl -X POST localhost:5173/api/events/pr.opened \
    -H "X-Sammy-Signature: t=$T,n=$N,v1=$SIG" -d "$BODY"
  ```

- **legacy:** `sha256=<hex HMAC-SHA256 of the raw body>` — still accepted so
  existing callers keep working, but it has no replay protection; new
  integrations should send v2.

Internal chain events (`<orch>.done` fired by a finishing run) never need a
signature — signing gates the HTTP surface only.

### Receiving a real provider's webhook

`"signed": true` is for callers you control. No third party will ever send
`X-Sammy-Signature` — GitHub signs `X-Hub-Signature-256`, Stripe signs
`Stripe-Signature`, and each computes its HMAC over a different payload. So
name the provider instead and sammy-pack verifies *that* scheme:

```json
{ "kind": "webhook", "path": "gh", "signed": "github" }
```

Point GitHub at `https://your-host/api/triggers/gh`, set its webhook secret to
the same value as `SAMMY_WEBHOOK_SECRET`, and deliveries verify with no proxy
or translation layer in between.

| `signed` | Header(s) read | Signed payload | Timestamped |
| --- | --- | --- | --- |
| `true` | `X-Sammy-Signature` | `<t>.<n>.<body>` (v2) or `<body>` (legacy) | yes (v2) |
| `"github"` | `X-Hub-Signature-256` | raw body | no |
| `"stripe"` | `Stripe-Signature` | `<t>.<body>` | yes |
| `"slack"` | `X-Slack-Signature`, `X-Slack-Request-Timestamp` | `v0:<ts>:<body>` | yes |
| `"shopify"` | `X-Shopify-Hmac-Sha256` (base64) | raw body | no |
| `"linear"` | `Linear-Signature` | raw body | no |
| `"standard-webhooks"` | `webhook-id`, `webhook-timestamp`, `webhook-signature` | `<id>.<ts>.<body>` | yes |
| `"gitlab"` | `X-Gitlab-Token` | *nothing* — see below | no |

Notes that matter in practice:

- **`"github"` covers more than GitHub.** Bitbucket, Jira and Gitea send the
  same `X-Hub-Signature-256` construction.
- **`"standard-webhooks"`** is the [standardwebhooks.com](https://standardwebhooks.com)
  spec, so it also covers Svix, Resend, Clerk and Brex. Keep the secret in its
  `whsec_…` form: the HMAC key is the base64-**decoded** bytes after that
  prefix, and using the printable string instead is the usual reason every
  delivery 401s.
- **`"gitlab"` is not an HMAC.** GitLab sends the shared secret itself in a
  header, which proves the caller knows the token but signs nothing — a
  tampered body still verifies, and anyone who captures one request can replay
  it forever. It is supported because it is all GitLab offers; prefer an HMAC
  provider wherever you have the choice.
- **Timestamped schemes** reject a request whose timestamp is more than ±300 s
  from server time, which bounds how long a captured delivery stays usable.
  The signature-only schemes have no such bound — that is the provider's design,
  not sammy-pack's.
- **Provider schemes are not replay-cached.** Providers *retry* failed
  deliveries, often re-sending the same id, so rejecting a repeat as a replay
  would silently drop real events. Duplicate suppression is the delivery
  layer's idempotency key instead.
- **Naming a provider replaces the native scheme**; it does not add to it.
  `X-Sammy-Signature` is rejected on a `"signed": "github"` trigger, so
  declaring a provider can never leave a second, weaker way in.
- For a shared name, **strictest still wins**, but two subscribers naming
  *different* providers is a conflict: no single request could satisfy both, so
  the fire is refused `500` naming them rather than quietly enforcing whichever
  registered first. `GET /api/triggers` reports it as `signatureConflict`.

`GET /api/triggers` reports `signatureProvider` and `signatureHeaders` for
every signed trigger, so a caller can discover what to send.

### Request body limits

Every scheme HMACs the **raw bytes** of the request, so the ingress verifies
against those bytes rather than a decoded string — decoding first replaces any
non-UTF-8 byte with U+FFFD, which changes the digest and rejects a correctly
signed delivery.

A signature can only be checked once the body has been read, so the ingress is
reachable before authentication and the body is capped:
`SAMMY_MAX_BODY_BYTES` (default 5 MiB) → `413` past the cap, with no run
started.

### Running the gated suites

Most tests need nothing. Two groups need a container, and both SKIP cleanly
without one:

```bash
docker compose -f docker-compose.test.yml up -d --wait
cd app
npm run test:integration   # Kafka / RabbitMQ / SQS adapters vs real brokers
npm run test:postgres      # the Postgres store contract + the full path on PG
docker compose -f docker-compose.test.yml down -v
```

The Postgres one matters more than it looks: every other lifecycle suite runs
on SQLite and always will, while the store layer's SQL is written once per
backend and diverges precisely where reliability lives (the `SKIP LOCKED`
claim, the partial unique index, the fenced updates). Both dialects typecheck
identically, so a Postgres-only mistake only surfaces by running it.

## Reliability knobs

These exist because the failure modes they bound are silent by default — the
work stops while everything still reports healthy.

| Env var | Default | What it bounds |
| --- | --- | --- |
| `SAMMY_MAX_BODY_BYTES` | 5 MiB | Largest request body buffered; `413` beyond it. |
| `SAMMY_POLL_TIMEOUT_MS` | 30 000 | A polling fetch. A tick re-arms the trigger only in its own `finally`, so an un-timed fetch that never settles retires that poller for the life of the process. |
| `SAMMY_POLL_MAX_BODY_BYTES` | 1 MiB | A polled response. The body becomes a run's initial input and is stored whole, so an unbounded read is a DoS reachable by whoever controls that URL. Oversized responses are truncated, loudly. |
| `SAMMY_MAX_QUEUE_DEPTH` | 1000 | Pending deliveries; HTTP fires get `429` beyond it. |

### Idempotency keys are scoped

A fire's dedupe key is scoped to **owner + trigger kind + trigger name**, with
each component percent-encoded, and the caller's `Idempotency-Key` appended.
So the same key on two different endpoints is two fires, as you would expect —
`POST /api/deploy/staging` and `POST /api/deploy/production` with
`Idempotency-Key: release-1.2.3` both run. The same key on the *same* endpoint
still dedupes, which is the actual contract a retrying sender wants.

Without an `Idempotency-Key`, a key is derived from the kind, name, subscriber
set and body, and dedupes only within a short window — so an accidental
double-delivery collapses while two legitimately-identical events later do not.

### A cron will not overlap itself

A cron trigger defaults to `overlap: "skip"`: if the previous run of that
orchestration is still going when the next tick arrives, the tick is dropped.

This matters more than it sounds. The task is registered with node-cron's
`noOverlap`, which only suppresses a tick while the previous *callback* is
pending — and that callback just writes a delivery row and returns in
milliseconds. The run itself is created later, by the worker. So a
`* * * * *` cron on a ten-minute orchestration used to accumulate ~10
concurrent runs, each spawning agent subprocesses, with nothing to cap it:
`SAMMY_MAX_QUEUE_DEPTH` counts only *pending deliveries*, which drain
instantly.

```jsonc
{ "kind": "cron", "expr": "*/5 * * * *", "overlap": "queue" }
```

| `overlap` | Behaviour |
| --- | --- |
| `"skip"` (default) | Drop the tick; the running job continues. |
| `"queue"` | Park the tick and run it when the previous finishes. Bounded, but a persistently slow run builds a backlog. |
| `"allow"` | No guard — overlapping runs. Deliberate opt-in only. |

An explicit root-level `concurrency` block always wins over this.

### Cron timezones

A cron expression is evaluated in the **server's local zone** unless you say
otherwise, which means `"0 9 * * *"` denotes a different moment depending on
where the process runs. Set it explicitly for anything whose timing people
depend on:

```jsonc
{ "kind": "cron", "expr": "0 9 * * *", "timezone": "America/New_York" }
```

The zone also scopes the fire's dedupe bucket, which is why it matters for
correctness and not just clarity: the bucket is the **wall-clock slot**, so a
DST fall-back — when the local hour occurs twice — fires once rather than
twice. (An epoch-derived bucket put those two passes an hour apart and ran a
once-daily job twice.) Spring-forward is the mirror image: the hour never
exists, so the fire is skipped. That is conventional cron behaviour and is not
worked around.

`GET /api/triggers` always reports the effective `timezone` and whether it was
`declared` or inherited from the `server`.

### Deliveries: fencing, dedupe and retention

- **One accepted fire produces at most one run.** A claim carries a
  monotonic token, and every terminal update is fenced on it, so a worker
  that stalled past the reclaim window cannot settle a delivery that was
  re-claimed and run by someone else — it reports a lost claim instead.
- **A header `Idempotency-Key` is unique per orchestration at the storage
  layer** (a partial unique index), so two simultaneous posts of one key
  cannot both insert. The pre-insert read is only a fast path.
- **A fan-out is completed, not re-deduped.** A multi-subscriber event writes
  one row per subscriber; if that is interrupted part-way, a retry with the
  same key fills in the missing subscribers rather than being dismissed as a
  duplicate.
- **`deferred`** is its own delivery status: the fire is durably parked behind
  a busy concurrency group and *will* run. It is deliberately not `rejected`,
  so it stays out of the dead-letter view and cannot be replayed into a
  second run.
- **Transient refusals are retried, not dead-lettered.** A fire arriving while
  a daily spend cap is tripped, or during an orchestration hot-reload, backs
  off and retries rather than being permanently lost.
- **Retention covers deliveries** when `SAMMY_RUN_RETENTION_DAYS` is set.
  Note the trade: pruning a row forgets its idempotency key, so the same key
  can fire again afterwards. That is why it is opt-in.
- **A refusal does not consume the key.** A `rejected` or `failed` delivery
  never ran, so it does not suppress a retry — a provider re-sending a
  delivery you refused (budget cap, missing orchestration, queue full) will
  run once the cause is fixed. Only live-or-fired rows own a key.
- **A re-sent fire is counted, not just collapsed.** The row that won the key
  carries a `duplicateCount`, and `GET /api/deliveries/stats` reports
  `duplicatesSuppressed` — so a provider double-sending is visible without
  writing a row per retry.
- **A throttled fire from an internal producer is recorded.** An HTTP caller
  gets `429` and can retry, so nothing is stored for it. A cron tick or an
  internal event has no such channel, so it is written as a `rejected`
  delivery — visible, replayable, and counted against the cron breaker —
  rather than dropped with only a log line.
- **Concurrency groups exclude across PROCESSES**, not just within one. The
  gate takes a durable, self-expiring lock as well as its in-process mutex, so
  several workers against one Postgres cannot all pass the same check. It
  fails *open* with a loud log if it cannot get the lock: blocking a fire
  forever is a worse failure than briefly allowing the overlap.

### Queue sources: retries and poison messages

The three broker adapters pace retries differently, because the brokers do:

- **SQS** redelivers on its own after the visibility timeout, so a failure just
  leaves the message un-deleted.
- **RabbitMQ** has no server-side redelivery delay, so `nack(requeue)` is
  **held behind an exponential backoff** (`retryBackoffMs`, default 1 s,
  doubling to `maxRetryBackoffMs`, default 30 s, reset on the first success).
  Requeueing immediately turns a brief core outage into a sustained retry storm
  aimed at the service that is already failing. A poison message is
  dead-lettered via the broker's DLX rather than hot-looped.
- **Kafka** has neither, so a failure **pauses the partition and resumes it
  after the same backoff**. A pause nobody lifts is permanent: the partition
  goes silently deaf for the life of the process while the consumer still
  reports healthy.

Kafka has no dead-letter primitive, so a non-retryable refusal takes an
explicit policy — `onPoison`, default `'stop'`: pause and halt the source with
an error, losing nothing and preserving order, so a supervisor restarts it or
an operator sees it. `'skip'` commits past the record and keeps consuming,
logging loudly, and is opt-in because it *is* data loss.

Callers may also send an `Idempotency-Key` header — redelivering the same key
records one delivery, not two.

## Intake controls

Options that decide what an inbound fire becomes, for automations fed by
external events (error reports, tickets, alerts) — where volume is outside
your control and payloads carry other people's data.

### Scrub the payload at ingress (`scrub`)

On an HTTP-fired trigger (`webhook` / `events` / `deployment` / `queue`),
`scrub` is applied to the body **before the delivery is stored**, so the raw
payload never reaches the run store, a prompt, a ticket or a log:

```jsonc
{
  "kind": "queue",
  "queue": "errors",
  "scrub": {
    "allowFields": ["title", "route", "release", "user", "samples.*.stack"],
    "hashFields": ["user"],
    "patterns": [{ "pattern": "ORD-\\d+", "replacement": "[order]" }]
  }
}
```

In order: `allowFields` (when set, ONLY these JSON paths survive — the strong
form: a field the sender adds later is dropped by default), `dropFields`,
`hashFields` (scalar values replaced by a salted digest — countable, not
readable; the salt is `SAMMY_SCRUB_SALT`, and with no salt the field is
dropped, because an unsalted digest of a short id is reversible), then the
built-in detectors — `email`, `phone`, `bearer`, `jwt`, `secrets` (all on
unless `builtins` narrows or disables them) — and any custom `patterns` over
every remaining string value AND object key (numbers are left as numbers —
drop or allowlist a numeric field you need gone). Paths are dot-separated;
`*` matches any key or array index. A form-encoded body (`a=1&b=2`) is
decoded and treated as a flat object, so the field policies apply and `%40`
cannot hide an email from the detectors. Any other non-JSON body gets the
detectors as text — unless `allowFields` is set, in which case it is
replaced (fail closed). When a trigger scrubs, the stored `Idempotency-Key`
is a digest of the header, not the header itself. The delivery's `detail`
records what was done (`scrubbed: 3 value(s) redacted, …`). This is defense
in depth: scrub at the source too.

### Windowed idempotency (`idempotencyTtlSeconds`)

An `Idempotency-Key` header normally suppresses a repeat **forever** (per
orchestration). With `idempotencyTtlSeconds` on the trigger it suppresses
repeats only inside a sliding window from the most recent accepted fire, then
the key is accepted again — "one triage per error group per day" without
bucketing the date into the key yourself. Windowed keys cannot use the
forever-unique index, so their check-and-insert is serialized through the
store-backed group lock instead — two replicas sharing a store still accept a
key once.

### Pause an orchestration's intake

```
POST /api/orchestrations/{name}/pause    { "reason": "noisy release" }
POST /api/orchestrations/{name}/resume
GET  /api/orchestrations/{name}/intake
```

A kill switch that doesn't require editing or deleting the orchestration.
While paused, HTTP-fired deliveries are **held** — accepted and stored, then
re-checked every minute without spending a retry attempt, never
dead-lettered — and released immediately on resume. Scheduled ticks (`cron`,
`polling`) are skipped instead: replaying a backlog of stale ticks in a burst
on resume is never what a schedule wants. Runs already in flight and manual
starts are unaffected. The switch lives in `<root>/intake-pauses.json`, so it
survives a restart and a standalone worker honors it.

### Per-orchestration limits (`limits`)

The root `limits` block — `maxRunsPerDay`, `maxCostUsdPerDay`,
`maxCostUsdPerMonth` — caps one automation, so a noisy source cannot spend
the whole workspace budget. Usage counts every run of the orchestration
(manual ones too); a trigger fire over a limit is held until the day (or
month) rolls over, and a scheduled tick is skipped. `GET …/intake` reports
usage and which limit is reached.

### Held deliveries

Pause, `limits` and the workspace budget cap all **hold** an HTTP-fired
delivery rather than fail it: it goes back to `pending` with its retry attempt
refunded and a later `available_at`, and its `detail` says why. (A
budget-blocked fire used to be retried into the dead-letter view within
seconds.) Scheduled ticks are refused instead — a held tick would replay as a
stale burst, and the next tick does the work. `SAMMY_MAX_QUEUE_DEPTH` counts
rows that are due plus rows backing off between retries (a failing start path
is exactly when ingress should push back), but never held rows — so pausing
one orchestration cannot make another one's ingress return `429`. A parked
concurrency-group fire whose drain is refused (budget, a transient error)
becomes a delivery itself, so it cannot be stranded; when it finally runs it
re-checks its group and parks behind a newer holder rather than overlapping
it.

## Accept ≠ execute: durable deliveries

Trigger ingress never executes a run inline. The request is recorded as a
**durable delivery** and acknowledged with `202` before any run exists; a
worker then claims the delivery and starts the run. That buys:

- **Durability** — a crash between accept and execute loses nothing; the
  delivery is still queued.
- **Retries with backoff** — a failed delivery is retried; deliveries that
  exhaust retries land in a **dead-letter** state, inspectable and replayable
  from the Deliveries page.
- **Multi-process safety** — on Postgres, claims use `FOR UPDATE SKIP LOCKED`,
  so several workers can drain one queue without double-execution.

The dev server (and the standalone server) drain deliveries in-process by
default. To run drain-and-execute as its own process — or several of them —
see the worker section of [`deployment.md`](deployment.md).

## Chaining runs (reactive orchestrations)

Every finished run emits a domain event: `<orchestration-name>.done` on
success, `<orchestration-name>.error` on failure — with the run's output as
the event body. Any orchestration can subscribe with an `events` trigger:

```jsonc
{ "kind": "events", "event": "intake-triage.done" }
```

That's the whole choreography mechanism: producer runs, event fires, consumer
runs. External systems join the same bus via `POST /api/events/<event>`.

A root-level `lifecycle.errorOrchestration` (a saved orchestration name) runs
after a failed run, receiving the failed run's id and error as input —
workflow-level recovery on top of per-node `onError`.

## Guard rails

All server-side, all env-configurable:

| Variable | Guards against |
| --- | --- |
| `SAMMY_MAX_EVENT_CHAIN_DEPTH` | runaway event loops (A triggers B triggers A …) — a run chain deeper than this is refused |
| `SAMMY_MAX_INFLIGHT_PER_ORCH` | one noisy orchestration starving the rest — per-orchestration concurrent-run cap |
| `SAMMY_MAX_QUEUE_DEPTH` | unbounded ingress — deliveries beyond the cap are rejected at accept time |
| `SAMMY_WORKER_CONCURRENCY` | how many deliveries one worker executes at once |

Budget caps apply to triggered runs as to manual ones — a run is halted if it
crosses the cap mid-flight (see [`deployment.md`](deployment.md)) — except
that a triggered fire arriving while the cap is spent is **held** until it
clears rather than refused (see [Held deliveries](#held-deliveries)).
Per-orchestration `limits` and the intake pause work the same way.
