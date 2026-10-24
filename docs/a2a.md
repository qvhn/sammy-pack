# A2A — agent-to-agent interop

sammy-pack speaks the [A2A protocol](https://a2a-protocol.org) in both
directions: every saved orchestration **is** an A2A agent other systems can
call, and any phase can dispatch **to** a remote A2A agent.

## Inbound — your orchestrations as A2A agents

| Endpoint | What it returns |
| --- | --- |
| `GET /.well-known/agent-card.json` | workspace root card (lists the orchestrations) |
| `GET /api/a2a/<name>/agent-card.json` | per-orchestration agent card |
| `POST /api/a2a/<name>` | JSON-RPC 2.0 task surface |

Supported JSON-RPC methods: `message/send`, `message/stream`, `tasks/get`,
`tasks/cancel`, `tasks/resubscribe`.

An A2A task maps **1:1 onto a durable run** — it lands in the same run store,
shows on the Runs page, checkpoints per phase, and is subject to the same
budget caps (a task is refused at the cap like any other run).
`message/stream` streams progress; `tasks/resubscribe` reattaches after a
client disconnect. When the API token or JWT layer is enabled
([`deployment.md`](deployment.md)), it covers these routes like any other
mutating `/api` route.

Try it against a running server:

```bash
curl -s localhost:5173/.well-known/agent-card.json | jq .
curl -s localhost:5173/api/a2a/refinement-loop/agent-card.json | jq .
```

## Outbound — the `a2a` node kind

An `a2a` leaf dispatches its phase to a remote agent: the executor fetches the
agent card, submits the upstream output as a task, polls to completion, and
folds the result artifact in as the phase output.

```jsonc
{
  "name": "remote-research",
  "a2a": {
    "agentCard": "https://research.example.com/.well-known/agent-card.json",
    "skill": "deep-research"        // optional skill id from the card
  },
  "timeout": 600,
  "retry": { "times": 2, "backoff": "exponential" }
}
```

Behavior matches any other leaf: it honors `timeout` / `retry` / `onError`,
participates in `${name}` state via `as`, and is **skip-replayed on resume**
— a completed remote call is not re-sent when a run resumes from checkpoint.

Two shipped examples exercise this path:

- **`federated-loopback`** — runnable on one server with zero tokens: its
  `a2a` phase calls the same workspace's `smoke-test` orchestration over
  real A2A (card fetch, JSON-RPC, task polling, a durable run on the
  receiving side). Change its `${peer}` var to another sammy-pack server's
  URL and it becomes genuinely two-workspace.
- **`federated-research`** — composes local phases with a remote research
  dispatch.

## Signed agent cards

A card tells the caller where to send tasks (`url`) — so a tampered card is
an endpoint swap. Cards can therefore carry **JWS RS256 signatures**:

- **Publisher side:** set `SAMMY_A2A_SIGNING_KEY` (RSA private key PEM) and
  every served card includes a `signatures` entry — the JWS over the
  canonical (sorted-keys) JSON of the card.
- **Caller side:** set `SAMMY_A2A_REMOTE_PUBLIC_KEY` (SPKI public key PEM)
  and every fetched card **must** verify against it — unsigned or tampered
  cards are refused before any task is sent (fail closed).

Generate a pair with `openssl genrsa -out a2a-signing.pem 2048` and
`openssl rsa -in a2a-signing.pem -pubout -out a2a-public.pem`. The pinned
key covers all remotes this workspace calls; leave both unset to skip
signing entirely (the local-dev default).

## Idempotent dispatch

A resumed run never re-sends a *completed* `a2a` phase (skip-replay covers
that). The residual risk is a phase that crashed mid-dispatch: on resume it
re-executes, and the remote may have already started the work. The
`idempotencyKey` decorator closes that for sammy↔sammy federation:

```jsonc
{
  "name": "remote-research",
  "a2a": { "agentCard": "https://research.example.com/.well-known/agent-card.json" },
  "idempotencyKey": "${ticketId}/remote-research"
}
```

The key is interpolated (use `${vars}` / `${as}` state to make it
run-scoped) and sent as `metadata.idempotencyKey` on the `message/send`. A
sammy-pack receiver returns the **existing task** for a repeated key instead
of starting a duplicate run. Honest scope: the receiver's dedupe cache is
per-process with a 24 h TTL — a restarted receiver forgets keys. Non-sammy
receivers see the key as standard A2A message metadata and may apply their
own dedupe.
