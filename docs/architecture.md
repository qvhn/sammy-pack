# Architecture

sammy-pack runs orchestrations — trees of agent phases — over a single source
of truth (orchestration JSON + agent markdown). There are two execution
surfaces: the **Claude CLI skill** and the **web app's server-owned executor**.
Both walk the same tree the same way; a parity test keeps them honest.

```
              ┌────────────────────────────────────────────┐
              │  workspace: examples/*.json  agents/*.md     │
              │             context/*.json  schema/          │
              └───────────────┬──────────────────────────────┘
                              │  single source of truth
              ┌───────────────┴────────────────┐
              ▼                                ▼
      ┌────────────────┐            ┌──────────────────────────┐
      │  Claude CLI    │            │   web app (Vite)         │
      │                │            │                          │
      │ SKILL.md walks │            │ browser  ──POST──►  dev   │
      │ the tree, runs │            │   thin       server owns  │
      │ each leaf via  │            │   SSE        the executor │
      │ the Agent tool │            │   client ◄──events── +    │
      │                │            │              SQLite store │
      └────────────────┘            └──────────────────────────┘
```

## The orchestration tree

An orchestration is a JSON `Node`. Every node has exactly one **body kind**
— the schema's 14: the leaves `agent`, `code`, `wait` and `a2a`, and the
composites `agents`, `phases`, `parallel`, `converge`, `loop`,
`conversation`, `route`, `switch`, `map` and `subflow` — plus optional
decorators (`lock`, `as`, `when`,
`prompt`, `retry`, `timeout`, `onError`, `budget`, `tools`, `maxTurns`,
`continueOnError`; `vars` at the root). The schema is
`schema/orchestration.schema.json`; the executor is `app/src/llm/executor.ts`.

## Server-owned execution (web)

The browser does **not** run the executor. It POSTs to the dev server, which
owns the run. This is what makes runs durable — closing the tab, or even
restarting the server, doesn't lose the run.

```
POST /api/runs/start
   │  body: { orchestrationName, initialInput?, model?, allowAgentTools? }
   ▼
run-controller.startRun()
   │  - inserts a row in runs.db (status='running')
   │  - kicks off the executor in the background, returns { id } immediately
   ▼
executor walks the tree
   │  - each leaf agent → streamSdk() → Claude Agent SDK subprocess
   │  - emits events: run-start, phase-start, phase-delta, phase-end, ...
   ▼
run-controller, per event:
   │  - appendEvent(db) — append-only events table
   │  - broadcasts to every attached SSE subscriber
   │  - after each leaf phase-end: checkpoint (completedLeaves + leafOutputs)
   ▼
GET /api/runs/:id/events   (SSE)
   │  - drains DB history first, then live-tails
   │  - client can disconnect + reconnect; the run keeps going server-side
```

### Modules (`app/src/server/`)

- **`run-store.ts`** — the `RunStore` interface: `runs` (header + checkpoint
  columns) + append-only `events`, behind one async API. Two backends:
  - **`db.ts`** (`SqliteRunStore`) — the default. One `runs.db` file, zero
    infra. PRAGMA-versioned migrations.
  - **`postgres-store.ts`** (`PostgresRunStore`) — opt-in, activated when
    `DATABASE_URL` is set. JSONB columns, idempotent schema setup. The
    enterprise / shared-deployment path.

  `openRunStore()` picks the backend by env var; the controller and HTTP
  layer never know which is underneath — an embedded file store for dev, a
  shared server for production, behind one interface.
- **`run-controller.ts`** — in-memory map of active runs. Owns the
  `AbortController` + the SSE subscriber set + a live event mirror per run.
  `startRun`, `subscribe`, `cancel`, `resume` — all over the `RunStore`.
- **`sdk-stream.ts`** — the single Claude Agent SDK call path. Shared by the
  HTTP proxy (`/api/llm/stream`) and the server-owned executor. Accepts text
  or multi-content (text + image) prompts.
- **`file-extractor.ts`** — converts an uploaded file (image / `.drawio` /
  `.excalidraw` / PDF / text) into content blocks for the designer agent.
- **`agent-matcher.ts`** — fuzzy-matches diagram-derived agent names against
  the workspace `agents/` directory.

## Durability

| Concern | Mechanism |
| --- | --- |
| Run survives tab close | Executor runs server-side; SSE is just an observer |
| Run survives server restart | Every event is in the run store; orphaned `running` rows (expired lease — never one the scanner's own controller still drives, but an own row the process has let go of counts) are flagged `interrupted` by the boot scan, a delayed re-scan and a periodic sweep, with their concurrency group released. Resuming them from the last checkpoint is **opt-in** (`SAMMY_AUTO_RESUME=1`) and server-only — and when it is on, the sweep resumes *before* it drains, so a parked fire cannot take the group out from under the crashed run. By default they wait in the Runs view for a manual Resume; the standalone worker marks them and drains the group each held, but never resumes |
| Resume from a pause | `lock: true` phases snapshot state + exit; `Resume` re-runs with skip-replay over the already-completed leaves |
| Resume of a grouped run | Resuming an `error` / `interrupted` run that declares a `concurrency.group` takes the group's durable lock (the same `concurrency_group_locks` row the start-gate takes) around its group check, status claim and `run-resumed` append — two resumes, or a resume racing a fresh start, exclude each other across processes and the loser is told the group is busy. The lock fails open after its 5 s wait, with a warning, like the start-gate |
| Terminal write fails | The final status write is retried three times (250 ms × attempt; each append done at most once across attempts). If it still fails the leg tears itself down anyway — heartbeat stopped, active map cleared, listeners closed, descendants reaped, terminal hook told via `terminalWriteError` — so the row (still `running`) is reclaimed as `interrupted`, i.e. resumable, by the orphan sweep once its lease lapses: this process's own sweep (the sweep spares an own row only while a controller still drives it) or a peer's. Being *told* is the point: both terminal hooks (server and worker) then fire **nothing** external — no event publish, notify, OTLP push, breaker count, `errorOrchestration` recovery run or group drain — because a terminal the store never recorded is not an outcome yet, and the next leg re-walks to the same terminal. The drain is skipped with the rest, so a fire parked behind that run waits for the reclaim (which drains) rather than being released by a terminal nobody recorded. It used to rethrow before any of that ran, leaving a lease-renewing zombie nobody could cancel or reclaim; and before the own-sweep rule, a single-process deployment held such a row and its group until a restart |
| Lease lost | The leg aborts its work, persists **nothing** further (the abort unwind's `phase-error` / `run-cancelled` are dropped, so they cannot land after the peer's `run-interrupted`) and schedules the same 1.5 s descendant reap a cancel does |
| Cancel | `AbortController` aborts the SDK subprocess; the run is classified `cancelled` (not `error`). Cancelling a run that is *not* live in the calling process goes through the store: the status flip is fenced on the status just read, so a resume that lands in the gap is re-read and cancelled live rather than stamped over (and `resume()` itself re-reads the row after registering its controller, unwinding without an executor if the flip landed first; `startRun` registers before its insert for the same reason); a victim that *is* live here is aborted and its unwind awaited (bounded, 5 s) before the new run starts, and exactly one `run-cancelled` is recorded when it unwinds in time |
| Checkpoint granularity | After each leaf phase-end — the boundary you can resume from (you can't resume mid-LLM-call) |
| Resume determinism | Leaves checkpoint under iteration-scoped replay keys (`loop@N/…`, `map[i]/…`, `subflow/…`), and router / loop-judge calls are themselves checkpointed leaves — a resumed run replays the same control-flow decisions and each iteration's own output instead of re-asking the model |

## CLI execution path

`.claude/skills/sammy-pack/SKILL.md` is a runbook for Claude Code: resolve the
orchestration, walk the tree, dispatch each leaf via the Agent tool, gate at
`lock` phases via `AskUserQuestion`. It uses the existing Claude Code session —
no API key.

The CLI and the web executor must support the same schema features. The
parity contract is documented in the schema's top-level `description` and
enforced by `app/__tests__/cli-parity.test.ts`, which fails if any node kind
or decorator is missing from `SKILL.md` or `executor.ts`.

## AI-assist: orchestration generation

Two entry points on the Pipelines page, both routed through
`agents/orchestration-designer.md`:

- **Generate from spec** — paste a PRD / requirements doc.
- **Drop a diagram / PRD** — drag an image, `.drawio`, `.excalidraw`, PDF, or
  text file. `file-extractor.ts` pre-processes it (drawio/excalidraw parse to
  a labeled node→edge list; images go to vision; PDFs are text-extracted),
  the designer emits an orchestration, and `agent-matcher.ts` reports which
  phases resolved to existing agents vs. need generation. Unmatched agents
  can be generated in one click.

## Connectors + workspaces (design, partially built)

`context/*.json` files point at where a workspace's data lives (repo, branch,
paths). A connector reads (and eventually writes) one kind of source —
GitHub, Bitbucket, GitLab, Linear. Auth tokens are never committed: they live
in the user's environment for the CLI, and in app-local storage for the web
app. The dev server currently reads the workspace from the local filesystem;
the connector layer is the path to remote-repo-backed workspaces.

## Safety: the sandbox policy layer

A tool-equipped agent (`tools: ["Bash", ...]`) runs real shell in the server
process. The `sandbox` decorator is a policy layer
(`app/src/server/sandbox-policy.ts`) whose four rules are enforced at two
different moments — worth being exact about, because only the first three
are preventive:

- **`allowedTools`** — an agent's declared tools are intersected with this;
  anything not listed is stripped. Applied *before* dispatch.
- **`networkAccess: false`** — drops `WebFetch` / `WebSearch`. Before
  dispatch.
- **`permissionMode`** — pins the SDK mode floor (`plan` = read-only). Before
  dispatch.
- **`deniedCommands`** — a Bash call whose command contains a denied
  substring (case-insensitive) is **refused before it runs** on server-owned
  runs: a `PreToolUse` hook denies that one call and tells the agent why, so
  it can do the task another way, and the run records a
  `sandbox-refused:<pattern>` tools-warning. Only that call is refused; the
  phase carries on. Elsewhere (an adapter without the hook) the executor's
  **post-hoc backstop** still fails the phase when it sees the `tool-use` —
  by then the subprocess may have started, so there it is detection, not
  prevention. Because matching is by substring, keep patterns specific
  (`git push --force`, not `rm -rf /`, which also matches every absolute-path
  `rm -rf`).

Sandboxes compose **tighten-only**: a node's effective policy is its own
merged with every ancestor's — allowlists intersect, denylists union, the
stricter permission mode wins. A child can never widen what a parent
restricted. This is defense-in-depth, *not* OS-level isolation — container /
microVM sandboxing is a separate, larger effort.

## Auth

When `SAMMY_API_TOKEN` is set in the server's environment, every
state-changing `/api` request (POST / PUT / DELETE / PATCH) must carry
`Authorization: Bearer <token>`. When a JWT verifier is configured, a
verified JWT is accepted instead and its owner claim becomes the identity.
The two gates **compose**: the verifier is built first; the bearer gate
accepts the static token and marks the request authenticated (a request-keyed
set, unforgeable by header), the JWT gate passes such a request through with
its `X-Sammy-User` identity intact and judges any other bearer as a JWT.
Reads stay open unless `SAMMY_REQUIRE_AUTH_READS` is on, which gates them too
— the SSE stream included. An `EventSource` cannot set headers, so
`GET /api/runs/:id/events` accepts `?token=` and `?owner=`; a small
middleware mounted before every gate lifts them into `Authorization` /
`X-Sammy-User` (header wins when both are present), so the bearer and JWT
gates verify a query token with the same code — there is no second verifier.
The price is a credential in a URL that proxies log; `docs/deployment.md`
lists the mitigations. Only the probes (`/livez`, `/readyz`, `/health`) are
exempt, and they drop any identity header. Trigger ingress is exempt from the
requirement but not from identity: an unauthenticated fire — whatever the
webhook's method — has its header stripped and runs as `system` under any
token or verifier posture (the strip runs before the reads-open shortcut in
both gates). Every gate classifies ONE canonical path (`gatePath`) rather
than the raw request target: case-folded because connect matches mounts
case-insensitively, with an absolute-form target's `scheme://authority`
dropped the way connect drops it, `#` / `?` cut and repeated slashes
collapsed — and with `.` / `..` deliberately left unresolved, because
resolving them would let a shortened path claim the probe exemption while
the resource's own handler answered it. The same two gate functions are also
mounted on the root `/metrics` under gated reads unless `SAMMY_METRICS_PUBLIC`
is on, and on the root A2A discovery card `/.well-known/agent-card.json`
(no public opt-out); both of those handlers enforce their own exact path and
404 any remainder, because connect strips a mount by length and a sub-path
reached the reused `/api` gates as their probe exemption. Unset (the
local-dev default) = no gate, and then the
header is trusted everywhere. The browser attaches the token via
a global fetch wrapper (`app/web/api-auth.ts`) reading localStorage
`sammy.apiToken` — written by the "API token" field under Settings → User
identity — and builds the stream URL from the same stored values through the
same reader, so the header path and the query path cannot drift. A stream the
server refuses before its first event is reported on the run card with the
server's text instead of leaving the run "running". The boot banner prints
the resulting posture unconditionally (`auth:` / `identity:` lines). This is
the seam a real per-user auth layer + multi-tenancy sit behind; there is no
login flow — a JWT comes from your own IdP.

## A2A protocol

sammy-pack speaks [A2A](https://a2a-protocol.org) (Agent2Agent) both
ways.

- **Inbound** — each saved orchestration is exposed as an A2A agent.
  `GET /.well-known/agent-card.json` is the workspace root card (gated like
  every other read under `SAMMY_REQUIRE_AUTH_READS=1`, since it enumerates
  every orchestration); `GET /api/a2a/:name/agent-card.json` is the
  per-orchestration card;
  `POST /api/a2a/:name` is a JSON-RPC 2.0 task surface
  (`message/send`, `message/stream`, `tasks/get`, `tasks/cancel`,
  `tasks/resubscribe`). An A2A Task maps 1:1 onto a durable run. Every
  task method is owner-scoped by the same identity the REST routes use —
  another owner's task answers `-32001 Task not found`, never 403, so the
  surface is not an existence oracle. `tasks/pushNotificationConfig/set`
  accepts only absolute `http(s)` URLs whose host is in
  `SAMMY_NOTIFY_ALLOWED_HOSTS`; the allowlist is empty by default, so push
  notifications are off until an operator names a host. `tasks/cancel`
  mirrors `POST /api/runs/:id/cancel`: a run live in this process is
  aborted, anything else — paused at a gate, interrupted, a peer's — is
  cancelled through the store with its group released; a task that is
  already terminal answers JSON-RPC error `-32002` (the A2A
  TaskNotCancelable code) naming its status, rather than a success echo.
- **Outbound** — the `a2a` node body kind dispatches a phase to a
  remote A2A agent: fetch the card, submit the upstream output as a
  task, poll to completion, fold the result artifact in as the phase
  output. It honors `timeout` / `retry` / `onError` and is
  skip-replayed on resume like any other leaf.

## Budget enforcement

`budget.json` at the workspace root holds a **global ceiling**
(`dailyUsd` / `monthlyUsd`, measured against workspace-wide spend) and
optional **per-owner caps** (`perOwnerDailyUsd` / `perOwnerMonthlyUsd`,
measured against the caller's own spend). A run is refused when either
breaches, and neither excuses the other. Spend is summed from the run
store's `phase-end` and `phase-error` cost events — a failed, retried or
cancelled attempt is charged what it consumed, so a retry storm is not free
— never from the cumulative `cost` events. Enforcement is server-side:
`POST /api/runs/start`, A2A `message/send`, trigger fires and the worker
refuse a run at a cap (the 402 names the cap that bit with its own figures),
and the run-controller halts a long run that crosses one mid-flight. The
Settings UI edits all four caps via `GET`/`PUT /api/budget` (an absent
per-owner field keeps the file's value, an explicit `null` clears it), and
`GET /api/budget/status` says which caps are `breached`.

## Multi-tenancy seam

Every run carries an `owner_id` (default `'system'`). What is scoped by it,
as a list rather than an "every": the per-run REST routes (`getRun` /
`getRunSummary` / `deleteRun` take the caller's owner, and a mismatch answers
404 rather than 403, so no route becomes an id-existence oracle); `listRuns`,
the observability digest and the cost digest; the A2A JSON-RPC task methods
(`message/send` and `message/stream` follow-ups, the idempotency lookup,
`tasks/get` / `tasks/cancel` / `tasks/resubscribe`,
`pushNotificationConfig/get` / `set` — a foreign task is `-32001`); the
deliveries list, stats and replay (an anonymous caller is `system`, never
unscoped); the concurrency view (`holder` and `queued` only for the caller's
own runs, withdrawals only of the caller's own fires); the `/api/llm/stream`
connection-ref expansion; and the credential store's `owners` visibility.
Engine-internal callers (sweepers, the delivery worker, the run controller,
retention, the global backpressure count) deliberately omit the scope,
because they operate across owners by design.

The owner is extracted from the `X-Sammy-User` header on each `/api` request.
The browser sets it from `localStorage['sammy.userId']` via the global fetch
wrapper (Settings → User identity).

JWT verification **is** built (`src/server/jwt-verify.ts`: HS256, RS256 with a
static key, and RS256 via JWKS with rotation; algorithm family pinned by env
precedence so there is no HS/RS confusion downgrade). When configured, the
verified claim overwrites the client-supplied header.

**This is the seam, not a full identity layer.** Reads are ungated by
default in both the bearer and JWT paths, and an unauthenticated read carries
whatever `X-Sammy-User` the caller chose — so owner scoping is only a
security boundary with **both** `SAMMY_REQUIRE_AUTH_READS=1` and a JWT
verifier set: the first stops an anonymous caller choosing an identity, the
second stops an authenticated one (the header is client-supplied until a
verified claim overwrites it). With either missing it is a UI convenience.
Set both for anything multi-user; an anonymous read then has its identity
header stripped rather than trusted, an unauthenticated trigger fire runs as
`system` instead of a self-declared owner, and the SSE stream carries its
credentials in the query string through the same gate. A static
`SAMMY_API_TOKEN` composes with the verifier but does not add identity: a
token caller is whatever `X-Sammy-User` it sends.

## What is not yet built

- **Multi-tenancy, SSO, and anything past two roles.** Identity answers
  *who* and a `read` / `write` role answers the coarsest *what*; there is no
  per-resource permission, no login flow (bring a JWT from your own IdP) and
  no per-team namespace — the workspace, the credential store (entries may
  name `owners`, but it is one file) and the webhook secret are shared. Spend
  has a global ceiling plus per-owner caps. One instance per team is the
  supported shape.
- **OS-level agent sandboxing.** The policy layer above is enforcement
  mostly before dispatch (the Bash denylist is a post-hoc backstop); true
  isolation (containers / microVMs) is separate
  (gVisor recommended; the executor's `AgentRunner` seam is the plug
  point). Implementation deferred — adds a real container-runtime
  dependency.
- **Mobile.** RN iOS/Android projects exist but aren't maintained.
