# Docs index

New here? Read in this order: **getting-started → patterns → schema**. The
rest is reference for when you need it.

| Doc | What it covers |
| --- | --- |
| [`getting-started.md`](getting-started.md) | Clone → first run: launch, run examples, watch/approve/fork runs, author orchestrations + agents |
| [`patterns.md`](patterns.md) | The orchestration shapes — sequential, fan-out, converge, loops, routing, subflows — and when to reach for each |
| [`schema.md`](schema.md) | The formal spec: every node body kind and decorator, with examples |
| [`architecture.md`](architecture.md) | How execution works: server-owned runs, durability, checkpoint/resume, CLI↔web parity, sandbox policy |
| [`harness.md`](harness.md) | Harness runs: one agent follows the steps and does each itself (skills, strictness, gates, taking a run over in a terminal) |
| [`triggers.md`](triggers.md) | Firing runs from outside: webhooks, cron, polling, events, queues, deploys; durable deliveries; chaining runs |
| [`PLUGGABLE_QUEUE_SOURCES.md`](PLUGGABLE_QUEUE_SOURCES.md) | ADR — pluggable broker adapters (SQS/Kafka/Rabbit) behind the `queue` trigger: the narrow-waist Source contract, ack-on-2xx reliability, out-of-process runners |
| [`deployment.md`](deployment.md) | Standalone server + workers, SQLite→Postgres, auth (API token / JWT), spend caps, env-var reference |
| [`DOCKER.md`](DOCKER.md) | Containerized deployment: the server+worker image, single-node SQLite and N-server/M-worker Postgres compose topologies |
| [`a2a.md`](a2a.md) | A2A interop: orchestrations as callable agents (inbound) and the `a2a` node kind (outbound) |
| [`calibration.md`](calibration.md) | Measuring LLM-judge accuracy against labeled datasets and improving it with human corrections |
| [`context-engineering.md`](context-engineering.md) | Scope, compress, retrieve, remember — the context toolkit agents and patterns |
| [`AUTHORING_ORCHESTRATIONS.md`](AUTHORING_ORCHESTRATIONS.md) | The field guide — cost model, failure semantics, concurrency, resumability, and the preflight checklist |
