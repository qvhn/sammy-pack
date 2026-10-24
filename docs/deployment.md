# Deployment — beyond the dev server

The dev server is the default surface: one process, web UI + API + executor,
SQLite store, zero infra. When you outgrow it, the same API and engine run as
standalone processes.

## The three processes

| Process | Command | What it does |
| --- | --- | --- |
| **Dev server** | `npm run web` (or `./sammy-pack start`) | Vite dev server with the full API + executor mounted. The local-dev default. |
| **Standalone server** | `npm run build:web && npm run serve` | Plain `http` server mounting the *identical* API surface (REST, SSE, triggers, A2A) and serving the built SPA from `web-dist/`. No Vite at runtime. `PORT`/`SAMMY_PORT` to bind; `SAMMY_REPO_ROOT` to point at a workspace other than the repo it runs from. |
| **Worker** | `npm run worker` | Drains the durable trigger-delivery queue as its own process. **Direct mode** (default): builds and executes runs in-process with the same guarantees as the server — budget caps (global ceiling + the run owner's per-owner cap, on both the delivery and the recovery path), reactive `<orch>.done` events (with each subscriber's ingress `scrub` applied), `errorOrchestration` recovery, `notify.onTerminal` / `notify.onGate` (the same envelopes the server sends), root `worktrees` cleanup, the intake pause and root `limits`, and the concurrency gate including its queue: a fire parked behind a busy `queue` group is released at the holder's terminal (and when the orphan sweep reclaims a holder, and when `cancel-existing` cancels one) as a `concurrency-drain` delivery into the worker's own queue, so it re-enters the gate on the next poll instead of being started inline. `cancel-existing` decides under the group lock, then cancels each victim **through the store** outside it (row → `cancelled` + sentinel, awaited; a local executor is aborted too and its unwind awaited, bounded 5 s, before the new run is inserted) and re-enters, bounded at three passes before starting anyway. **Delegate mode** (`SAMMY_SERVER_URL=http://…`): POSTs `/api/runs/start` to a running server instead, which then owns execution. One thing the worker never does: resume. Its orphan sweep marks a dead peer's runs `interrupted` — and its own abandoned rows, those no controller here still drives — drains the group each one held, and stops there. |

## Run store: SQLite → Postgres

- **SQLite (default)** — one `runs.db` file at the repo root. Zero setup,
  right for a single process.
- **Postgres (opt-in)** — set `DATABASE_URL`; schema setup is idempotent.
  This is the shared-deployment path: run **N servers + M workers against one
  Postgres**. Safety comes from two mechanisms:
  - delivery claims use `FOR UPDATE SKIP LOCKED` (no double-dispatch);
  - every run holds a **lease** (owner + expiry, heartbeat-renewed) and event
    writes are **fenced** on it — a process that loses its lease cannot write
    to the run, so each run has exactly one writer.

  On boot, on a delayed re-scan and on a periodic sweep
  (`SAMMY_ORPHAN_SWEEP_MS`) orphaned `running` rows whose lease has expired
  are marked `interrupted`, their concurrency group is released and any fire
  parked behind it is drained. They are **not** resumed unless
  `SAMMY_AUTO_RESUME=1` is set — the default leaves them in the Runs view for
  a manual Resume / Cancel, because re-spawning every in-flight run at once
  after a crash is a stampede. With it set the order matters: the sweep
  **resumes first, then drains** — only a run that did not resume (and whose
  group has no active run) releases its parked fire; a resumed run re-takes
  its group and its own terminal drains the queue behind it. (The drain used
  to run first, took the group, and the resume was then refused as "busy".)
  Only the server resumes; the standalone worker's sweep marks and drains
  but never resumes. A store spares its own expired-lease row only while a
  controller in that process still drives the run (a blocked event loop is
  not a dead process), and a live peer's lease keeps renewing, so neither is
  stolen; an own row the process has let go of — a leg whose terminal write
  failed every retry — is reclaimed by that same process's next sweep once
  the lease lapses, exactly like a dead peer's.

  Three more properties of the lease machinery, each closing a specific way a
  run could be stranded:

  - **Resume is group-locked.** Resuming an `error` / `interrupted` run that
    declares a `concurrency.group` takes the same durable
    `concurrency_group_locks` row the start-gate takes (holder
    `resume-<pid>-…`) around its group check, its status claim and the
    `run-resumed` append. Two resumes of one group — or a resume racing a
    fresh start — exclude each other across processes; the loser gets
    `Concurrency group "<g>" is busy`. Like the start-gate, the lock fails
    **open** if it cannot be acquired in its 5 s window (10 s TTL), with a
    `[run-controller] concurrency:` warning.
  - **A failed terminal write does not leave a zombie.** The final status
    write is retried three times (250 ms × attempt backoff; each append is
    done at most once across attempts, so a retry cannot duplicate a
    sentinel). If it still fails the leg tears itself down anyway: the
    heartbeat stops, the run leaves the active map, listeners close, the
    descendant reap runs and the terminal hook fires with a
    `terminalWriteError`. The row keeps reading `running` until the orphan
    sweep reclaims it as `interrupted` once its lease lapses — this process's
    own sweep (which spares an own row only while a controller still drives
    it), or a peer's — resumable, which is the honest state for a run whose
    end could not be recorded. A loud `terminal write FAILED after 3
    attempts` error is the only operator signal, and it is the only thing
    that happens: the hook is told via `terminalWriteError` and then fires
    **nothing** external — no `<orch>.done` / `.error` publish, no
    `notify.onTerminal` POST, no OTLP push, no cron-breaker failure count, no
    `errorOrchestration` recovery run and no group drain — because a terminal
    the store never recorded is not an outcome yet, and the leg that does
    record one owns those effects. **So do not alert on
    `notify.onTerminal` for this case**: alert on that log line, or on a
    `running` row past its lease. The drain is skipped with the rest, so a
    fire parked behind that run is released by the reclaim (which drains)
    rather than by the terminal — budget up to the lease TTL
    (`DEFAULT_LEASE_TTL_MS`, 120 s) plus the sweep cadence
    (`SAMMY_ORPHAN_SWEEP_MS`, same default) — or by a resumed leg's own
    terminal.
  - **Lease loss is total.** Once a leg learns its lease is gone it stops
    persisting anything — the de-leased executor's abort unwind (a leaf
    `phase-error`, then `run-cancelled`) is dropped, so it cannot land after
    the peer's `run-interrupted` — and it schedules the same 1.5 s descendant
    reap a cancel does, so a leg wedged in a hung tool does not keep its
    children alive under a row it no longer owns.

  **An unreachable `DATABASE_URL` at boot is fatal**: the Postgres store's
  `init()` throws, the server logs `[serve] fatal:` and exits 1 — under
  compose's `restart: unless-stopped` that is a crash loop, which is the loud
  outcome a misconfigured URL should produce. `/api/readyz` answering 503 is
  the path for a store that fails *after* boot.

## Identity and auth

Three layers. The first two **compose** — a bearer is accepted when it is
*either* the static token *or* a JWT the verifier accepts — and each protects
something specific, so the posture you get is the sum of what you set, not
the strongest single setting. The table after the three layers says exactly
who can do what under each combination.

**1. API token (coarse gate).** Set `SAMMY_API_TOKEN`; every mutating `/api`
request (POST/PUT/DELETE/PATCH) must carry `Authorization: Bearer <token>`.
Reads stay open unless `SAMMY_REQUIRE_AUTH_READS` is on, which gates them too
— the SSE stream, the root `/metrics` (`SAMMY_METRICS_PUBLIC` re-opens it)
and the root A2A discovery card `/.well-known/agent-card.json` (no opt-out)
included. Only the probes (`/livez`, `/readyz`, `/health`) stay reachable
without a token, and they drop any identity header. The token itself is
compared in constant time. What the token
does **not** do: identify anyone. A token caller's identity is still the
`X-Sammy-User` header it chose, so with the token alone every token holder is
one shared admin who can read and write under any owner id.

**2. JWT verification (per-user identity).** Runs are scoped by an
`owner_id`. Without a verifier, the server trusts the `X-Sammy-User` header
as-is — that is *scoping*, not security. To verify users, configure exactly
one verifier; precedence if several are set:

| Variable | Verifier |
| --- | --- |
| `SAMMY_JWKS_URI` | RS256 via a JWKS endpoint (key rotation handled; cached by `kid`) |
| `SAMMY_JWT_PUBLIC_KEY` | RS256 via a static PEM public key |
| `SAMMY_JWT_SECRET` | HS256 shared secret |

Each verifier is pinned to its algorithm family, so HS/RS confusion-downgrade
is structurally impossible. Optional claim checks: `SAMMY_JWT_AUDIENCE`,
`SAMMY_JWT_ISSUER` (the boot log warns when unset), and
`SAMMY_JWT_OWNER_CLAIM` selects which claim becomes the owner id. A verified
subject **replaces** the raw header. A role claim is read **only** when
`SAMMY_JWT_ROLE_CLAIM` names one (there is no default); it may be a literal
key or a dotted path such as `realm_access.roles`, and a string array counts
as `write` if any member spells it.

**How 1 and 2 compose.** With both set, the bearer gate accepts the static
token and records the request as authenticated; the JWT gate passes such a
request through untouched (its identity stays the `X-Sammy-User` header, as
for every token caller) and judges any *other* bearer as a JWT — a verified
one sets the identity from the owner claim whatever header was sent, an
unverifiable one is refused with the verifier's reason. The two gates used to
run in series and no string satisfied both, so the documented "token +
verifier" posture answered 401 to every mutation; the boot banner now reads
`mutating /api routes require the bearer token OR a verified JWT` for it, and
`gated by the JWT verifier only` for a verifier without a token.

What each posture gives you, as "who may do what":

| Posture | Mutations | Reads (open / gated) | Identity |
| --- | --- | --- | --- |
| nothing set | anyone | anyone / *flagged* `GATED IN NAME ONLY` — nothing can verify a token, so reads stay open | the header, trusted everywhere — trigger ingress included |
| token only | token holders | anyone / token holders | the header; every token holder may act as any owner |
| verifier only | verified JWTs | anyone, with the header **stripped** on an anonymous read / verified JWTs | the claim |
| token + verifier | token holders **or** verified JWTs | anyone (stripped) / token holders or verified JWTs | the header for token callers, the claim for JWT callers |

Owner scoping and roles are a security control only in the two verifier
postures **with reads gated** — see *Roles* below and `SECURITY.md`. A token
caller is one shared identity in every posture.

**Trigger ingress identity.** Ingress (`/api/triggers`, `/events`, `/deploy`,
`/queue`) is exempt from the *requirement* to authenticate — a sender's
credential is its HMAC signature, and a provider may send an `Authorization`
of its own that is no JWT — but not from identity. Under any posture with a
token or a verifier, a fire that carries neither the api token nor a
verifiable JWT has its `X-Sammy-User` stripped and runs as `system`: it cannot
name an owner, so it cannot resolve that owner's credentials or spend their
per-owner cap — whatever the webhook's method, since the strip runs before
either gate's reads-open shortcut. A fire carrying the token keeps its
header; one carrying a verifiable JWT runs as the claim. In the fully open
posture (no token, no
verifier) the header is trusted on ingress exactly as it is everywhere else —
there is no gate to strip it in, and ingress trusting it is no escalation
over what every other route already grants.

**The SSE identity channel, and its trade-off.** An `EventSource` cannot set
headers, so `GET /api/runs/:id/events` — and only that route — accepts
`?token=` (≡ `Authorization: Bearer`) and `?owner=` (≡ `X-Sammy-User`). They
are lifted into the headers before any gate runs, so the same gate code
verifies them (a header, when present, wins), and `?owner=` is trusted
exactly as far as the header would be in the active posture. The cost: a
long-lived bearer in a URL query reaches whatever logs request lines — a
reverse proxy or load balancer's access log, a browser history. Two
mitigations, in order of preference: front the server with a proxy configured
to strip the `token` query parameter from its access logs; and issue
short-lived JWTs to browser sessions rather than handing them the static
admin token. The Settings → User identity "API token" field (stored in the
browser only, never echoed back, cleared with one button) is how the UI
holds the credential, not a third mitigation: the browser builds every
stream URL from that stored value, so what reaches the access log is the
same whether the token was typed into Settings or pasted into a URL. The
stream URL and the fetch wrapper's headers come from the same stored values,
so the two cannot drift. A refused
stream (401 / 404 before any event) is reported on the run card with the
server's own text and a pointer to that field, and the run is ended locally as
`error` rather than parked as "running".

**3. Webhook signing.** `SAMMY_WEBHOOK_SECRET` + `"signed": true` per trigger
— see [`triggers.md`](triggers.md).

## Spend caps

`budget.json` at the workspace root holds two kinds of USD cap:

- `dailyUsd` / `monthlyUsd` — the **global ceiling**, measured against
  workspace-wide spend. When it is reached, everyone's runs are refused; that
  is what a ceiling is for.
- `perOwnerDailyUsd` / `perOwnerMonthlyUsd` — an optional **per-owner cap**,
  measured against the caller's own spend. One owner over their cap is
  refused while others keep running.

A run is refused when **either** breaches, and the two are independent: a
per-owner cap never raises the ceiling, and the ceiling never excuses an owner
over their own cap. Enforcement is server-side and covers every path that
starts a run — manual, trigger, A2A, worker:

- at a cap, new runs are **refused** (402). The refusal names the cap that
  bit, with *its* figures — `this owner's daily cap (your spend today: $6.00
  / $5.00)` rather than the workspace numbers — and, when only a per-owner
  cap breached, points at `perOwnerDailyUsd` / `perOwnerMonthlyUsd` as the
  remedy;
- a run that crosses a cap mid-flight is **halted** at the next phase
  boundary;
- spend is summed from `phase-end` **and `phase-error`** cost. A failed,
  retried or cancelled agent attempt is charged what it consumed — the
  attempt's own token delta rides on its `phase-error` — so a retry storm
  counts against every cap and cannot burn under the mid-run gate. The
  cumulative `cost` events are never summed (they used to inflate the figure
  several-fold). Two visible consequences: reported spend for runs with
  retries is higher than before — on the Runs page card too, which sums the
  same two events so it agrees with a 402 and the cost digest (a failed
  phase's own block still shows no cost line) — and a run whose
  contract-violating or terminal-marker attempt was retried successfully now
  reports `degraded: true`, because it carries a `phase-error`.

All four caps are editable. `GET`/`PUT /api/budget` round-trip them and
Settings → Cost guardrails has the two per-owner fields beside the globals.
On `PUT` a per-owner field that is **absent** keeps the file's value (a client
that only knows the global pair cannot wipe them) and an explicit `null`
clears it; the Settings form always sends all four, `null` for a blank one.
`GET /api/budget/status` reports `breached` (`daily` / `monthly` /
`ownerDaily` / `ownerMonthly`) beside `blocked`, and the Pipelines banner
lists every cap at or past 80 %, worst first, with its own label — so a
per-owner breach reads as one. A path with no owner in hand (the boot banner,
the unscoped status read) evaluates the ceiling alone; the worker passes the
delivery's owner.

Per-node `budget` decorators (`maxTokens` / `maxCostUsd`) add circuit breakers
inside a run, independent of the workspace caps.

## Observability

- **Observability page** — success rate, cost trend, latency p50/p95, run
  counts, scoped per owner.
- **Trace export** — any run exports as OpenTelemetry OTLP/JSON, one span per
  phase, ingestible by any OTel-compatible backend.
- **Run store** — the append-only event log is the record of what each run
  did; everything the UI shows is derivable from it. It is not an audit log
  in the compliance sense: `DELETE /api/runs/:id` removes it, retention prunes
  it, and the only attributed action in it is a gate decision (`decidedBy`) —
  starts, cancels, deletes and credential edits record no actor.

## Roles

Two roles, `read` and `write`, enforced on every `/api` route by method:
`read` may GET/HEAD/OPTIONS and nothing else. There is **no user store and no
account creation** — a role comes from a verified JWT claim (only when
`SAMMY_JWT_ROLE_CLAIM` names one — the only trustworthy source), else from
`SAMMY_READONLY_USERS`, else defaults to `write` so an unconfigured
single-user deployment behaves as before. An unrecognised or unparseable
role value fails **closed** to `read`, so a typo in a claim downgrades rather
than escalates.

Trigger ingress is the one surface the method rule does not describe: an
external sender is not a user session, so an anonymous fire is judged by its
HMAC signature, not a role. But a request that *does* carry an identity
resolving to `read` is refused on any fire path (including GET-method
webhooks) with a message naming the trigger case, because firing a trigger
starts a run. Bare list GETs are unaffected.

Said plainly, because it is easy to oversell: with reads ungated, identity
comes from a client-supplied header, so a caller can send a different
`X-Sammy-User` and get `write`. **Role enforcement is a security control only
under `SAMMY_REQUIRE_AUTH_READS=1` with a JWT verifier** — the same
precondition owner scoping has. Without that it is a guardrail against
accident. The boot banner prints which of the two is in effect.

## What an agent can reach

An agent gets **everything the platform was given**: agent and `code.run`
subprocesses inherit the server's environment, including provider keys,
`DATABASE_URL` and the admin token. That is deliberate — an agent is meant to
be able to use the connections you configured — and it means **you assume the
risk for any connection data you provide to the platform.** Give the server
only the credentials you are willing for an orchestration to use.

Inheriting a secret and *persisting* it are different, though: the server's own
env secrets are redacted from run events, the SSE stream, exported traces and
the UI (`serverSecretValues()` in `scrub-secrets.ts`), so an agent echoing
`$SAMMY_API_TOKEN` does not write it into the durable log. The set is the
explicit list plus every env var whose *name* looks like a secret — it
contains `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASSPHRASE`, `KEY`,
`AUTHORIZATION`, `CREDENTIAL` or `COOKIE` anywhere, or ends in `_PWD`,
`_PASS` or `_AUTH` (`-Auth` too; case-insensitive), so `MYSQL_PWD`,
`DB_PASS`, `REDIS_AUTH` and `PRIVATE_KEY` count while the shell's `PWD`,
`SSH_AUTH_SOCK` and `GIT_AUTHOR_NAME` do not — with a value of 8 or more
characters, excluding names that end in a knob, count, location or label
suffix: `_MS`, `_SEC`, `_SECONDS`, `_DAYS`, `_BYTES`, `_COUNT`, `_LIMIT`,
`_FILE`, `_PATH`, `_DIR`, `_HEADER`, `_CLAIM`, `_NAME`, `_DOMAIN`, or that
contain `_MAX_`, `_TIMEOUT` or `_TTL` (`SECRET_NAME` and `COOKIE_DOMAIN`
are a name and a domain, not secrets). The same vocabulary decides which
keys the credential and MCP-registry masks hide. What is **not** covered:
the server's own console output — `console.*` lines are not scrubbed, so keep
stdout/stderr as private as the event log.

## Security posture (read before exposing a port)

Stated plainly, matching the README caveats:

- The `sandbox` decorator (tool allowlists, Bash command denylist, network
  toggle, permission-mode floor, tighten-only composition) is **policy-level
  enforcement, not OS isolation**. A tool-equipped agent runs in the server
  process.
- `code.source` runs in a `node:vm` context with no ambient I/O and bounded
  CPU/output — protection against accidents, not against a malicious author.
  `code.run` executes a real shell command; treat any orchestration using it
  as fully trusted.
- `code.source`'s `vm` context is handed real host objects (run state,
  `vars`), and a cross-realm host reference is the textbook `vm` escape — so
  for a *malicious* author it is equivalent to `code.run`, and leaving
  `SAMMY_ALLOW_CODE_RUN` unset does not make the host safe.
- Treat the deployment as a **trusted-author tool**: run it on a private
  network or behind the auth layers above, and only execute orchestrations
  and agents you'd be comfortable running in your own shell.
- **One instance per team.** What exists: two roles (`read` / `write`), a
  global spend ceiling with optional per-owner caps, and credential entries
  that can name `owners`. What does not: per-team namespaces, per-resource
  permissions, or isolation of the workspace itself. The orchestration files,
  the single `credentials.json`, `budget.json` and `SAMMY_WEBHOOK_SECRET` are
  shared by everyone on the instance — so any team that can sign for its own
  webhook can fire another's orchestration, and reaching the global ceiling
  refuses everyone's runs by design. A shared multi-team instance is not a
  posture this supports today.

## Environment variable reference

Two grammars to know before the table. **Boolean knobs:**
`SAMMY_REQUIRE_AUTH_READS`, `SAMMY_REQUIRE_SIGNED_TRIGGERS` and
`SAMMY_METRICS_PUBLIC` are read through `envFlag`, which accepts
`1` / `true` / `yes` / `on` and `0` / `false` / `no` / `off` (trimmed,
case-insensitive). Unset or the empty string (how a compose file leaves a
knob unset) is OFF, silently. A value that is present but none of those — a
whitespace-only value included — warns once at `[config]`; for the two
`REQUIRE_*` flags it then counts as **ON** (they fail closed — the operator
set a variable whose purpose is to refuse things), for `SAMMY_METRICS_PUBLIC`
it counts as OFF, the default. Every other boolean in
this table still compares against a literal: `SAMMY_AUTO_RESUME`,
`SAMMY_DISABLE_INPROCESS_WORKER`, `SAMMY_ALLOW_CODE_RUN`,
`SAMMY_HEALTH_PROBE` and `SAMMY_HEADLESS_TOOL_DENY` accept `1` or `true`;
`SAMMY_CRON_AUTO_PAUSE` and `SAMMY_RETENTION_VACUUM` accept `1` only.
**List knobs:** `SAMMY_READONLY_USERS`, `SAMMY_NOTIFY_ALLOWED_HOSTS` and
`SAMMY_LLM_STREAM_TOOL_ALLOWLIST` share one grammar (`envList`): entries
separated by commas, semicolons or whitespace, trimmed, empties dropped.
`SAMMY_IMPORT_ROOTS` is deliberately **not** on that grammar — a filesystem
path may contain spaces — and splits on `,`, `;` and the platform path
delimiter only.

| Variable | Used by | Purpose |
| --- | --- | --- |
| `SAMMY_PORT` / `PORT` | server | bind port (dev helper + standalone) |
| `SAMMY_REPO_ROOT` | server, worker | workspace root override (orchestrations, agents, SQLite path) |
| `DATABASE_URL` | server, worker | switch the run store to Postgres. Unreachable at boot = `[serve] fatal:` and exit 1 (a crash loop under a restart policy), not a 503 |
| `SAMMY_API_TOKEN` | server, worker (delegate) | bearer gate on mutating routes. Composes with a JWT verifier: a bearer is accepted when it is this token **or** a verifiable JWT; token callers keep their `X-Sammy-User` identity |
| `SAMMY_READONLY_USERS` | server | owner ids pinned to the **read** role (the shared list grammar: comma / semicolon / whitespace). No user store, no account creation — roles are pure config |
| `SAMMY_JWT_ROLE_CLAIM` | server | JWT claim carrying the role — **no default**; unset means the token's role claims are ignored (the allowlist still applies). Literal key or dotted path (`realm_access.roles`); string or string array. The only *trustworthy* source; a verified claim beats the allowlist |
| `SAMMY_LLM_STREAM_TOOLS` | server | `off` refuses tool-bearing `/api/llm/stream` calls with 403 naming the lever — `tools`, subagents (a subagent that omits `tools` inherits, so it counts) and any registry MCP server named in `mcp` (its tools would be listed to the model) — **and** runs the plain requests that remain with an empty built-in toolset: the policed tool list is passed to the SDK as its base `tools` (`[]` under `off`), so `off` is text-only, not merely un-pre-approved. Recommended for anything shared: that route is not sandbox-policed. The orchestration path is untouched |
| `SAMMY_LLM_STREAM_TOOL_ALLOWLIST` | server | intersect `/api/llm/stream` tool requests with this list, per subagent too; the intersection is also the SDK's base toolset for the call. Shared list grammar |
| `SAMMY_LLM_STREAM_PERMISSION_MODE` | server | the ceiling on the permission mode `/api/llm/stream` passes (`plan` / `default` / `acceptEdits` / `bypassPermissions`; default `default`). **Resolved once at mount** — a change needs a restart; an unrecognised value warns once at `[config]` and falls back to `default`. A caller may narrow it, never widen it (403, top-level or on a subagent). Upgrade note: the browser-proxy executor forwards each node's `permissionMode`, so a node asking for `acceptEdits` — accepted before the ceiling existed — now gets a 403 on every phase unless this is raised to `acceptEdits` or above |
| `SAMMY_NOTIFY_ALLOWED_HOSTS` | server | hosts (or `host:port`, case-insensitive; shared list grammar) an A2A `tasks/pushNotificationConfig/set` URL may target. **Empty = refuse all** — push notifications are off by default |
| `SAMMY_REQUIRE_AUTH_READS` | server | gates READS too (SSE stream, root `/metrics` and the root A2A agent card `/.well-known/agent-card.json` included). `envFlag` grammar; an unrecognised value counts as **ON**. **Required for multi-user**: without it an unauthenticated caller chooses `X-Sammy-User`, so owner scoping is not a control |
| `SAMMY_BIND_HOST` | server | listen address. Defaults to `127.0.0.1`; the container image sets `0.0.0.0` because a container must. The non-loopback warning says `Reads on /api are gated` when they are |
| `SAMMY_IMPORT_ROOTS` | server | extra absolute roots that `agents/import`, `orchestrations/import` and `agents/scan` may read from (workspace is always allowed); separated by `,`, `;` or the platform path delimiter (`:` on macOS / Linux, `;` on Windows — so a Windows drive letter never splits, and on POSIX a root containing a `:` cannot be expressed) — **never** whitespace, because a path may contain spaces. An allowed root is one the API can read and write through a symlink |
| `SAMMY_ORPHAN_SWEEP_MS` | server, worker | cadence of the orphaned-run reclamation sweep (default: the lease TTL). Marks and drains the reclaimed run's group; resumes only when `SAMMY_AUTO_RESUME` is set on the server |
| `SAMMY_AUTO_RESUME` | server | `1` / `true` → the boot scan / re-scan / sweep also resumes the runs it marked `interrupted` — **resume first, drain after**: only a run that did not resume (and whose group has no active run) releases the fire parked behind it; a resumed run re-takes its group and drains at its own terminal. **Off by default** (a crash with many runs in flight would re-spawn them all at once). The worker never resumes regardless |
| `SAMMY_RUN_RETENTION_DAYS` | server | the switch that turns retention **on**: prune terminal runs (`done` / `error` / `cancelled`, never paused / interrupted / running) and terminal deliveries older than N days, at boot + daily. Unset = keep forever. Pruning a delivery also forgets its idempotency key and the polling watermark it carried, so the same key can fire again afterwards — which is why it is opt-in (see [`triggers.md`](triggers.md)) |
| `SAMMY_RETENTION_BATCH` | server | rows per retention batch (default 500). On SQLite it bounds how long one delete blocks the event loop; on Postgres each batch is one transaction, so it also bounds each prune statement under `SAMMY_PG_STATEMENT_TIMEOUT_MS` |
| `SAMMY_RETENTION_VACUUM` | server | `1` to VACUUM after a prune. Off by default: a full-file rewrite is a multi-second synchronous freeze that can outlast the lease TTL |
| `SAMMY_MAX_RUN_LIST_LIMIT` | server | ceiling on `GET /api/runs?limit=` (default 1000) |
| `SAMMY_MAX_SPAWNING_READS` | server | in-flight ceiling on the two READS that spawn a child process — `GET /api/versions` (a `git log` / `git show` per request) and `GET /api/mcp-servers/status` (a `which` per stdio registry entry). Default 4; beyond it a request is shed with a `503` naming this variable rather than queued, and the slot is released in a `finally`. `runGit` itself also carries a 10 s spawn timeout and a 4 MB stdout cap, surfaced through the route's normal error response |
| `SAMMY_MAX_RUN_STREAMS` | server | process-wide cap on concurrent SSE run streams (`GET /api/runs/:id/events`). Default 64; beyond it a stream is refused with a `503` naming this variable — refused rather than stalled, because an operator watching a run wants an answer. The slot is released when the *response* closes, not when `end()` returns: a client that does not read leaves the whole replayed log in Node's write queue, and that buffered copy is the resource being bounded |
| `SAMMY_PG_POOL_MAX` / `SAMMY_PG_CONNECT_TIMEOUT_MS` / `SAMMY_PG_IDLE_TIMEOUT_MS` / `SAMMY_PG_STATEMENT_TIMEOUT_MS` | server, worker | Postgres pool sizing + timeouts (defaults 10 / 10s / 10s / 60s) |
| `SAMMY_GATE_TTL_HOURS` / `SAMMY_GATE_TTL_ACTION` | server | stale-gate TTL and what happens at it (`notify` or `cancel`) |
| `SAMMY_DEFAULT_NODE_TIMEOUT_SEC` / `SAMMY_DEFAULT_STALL_TIMEOUT_SEC` | server, worker | per-node hard cap and no-progress watchdog defaults |
| `SAMMY_MAX_CONCURRENT_AGENTS` | server, worker | process-wide cap on simultaneous agent dispatches. **Per process, so N workers = N× this against your provider rate limit.** Defaults to `max(2, min(6, cores-2))` — i.e. 2 on a 4-core box |
| `SAMMY_JWKS_URI` / `SAMMY_JWT_PUBLIC_KEY` / `SAMMY_JWT_SECRET` | server | JWT verifier (precedence in that order) |
| `SAMMY_JWT_AUDIENCE` / `SAMMY_JWT_ISSUER` / `SAMMY_JWT_OWNER_CLAIM` | server | JWT claim validation / owner mapping |
| `SAMMY_WEBHOOK_SECRET` | server | HMAC secret for signed trigger ingress (webhook/events/queue/deploy) |
| `SAMMY_REQUIRE_SIGNED_TRIGGERS` | server | on → an unsigned HTTP-fired trigger (webhook / events / deployment / queue) is refused 403 at fire time, before the body is read; the boot banner prints `signed triggers: REQUIRED` and warns per registered unsigned trigger. `envFlag` grammar; an unrecognised value counts as **ON** (previously anything but `1` silently meant off) |
| `SAMMY_METRICS_PUBLIC` | server | on → keep the root `/metrics` scrape open when reads are gated (by default the same bearer / JWT gates are mounted on it, so a scrape needs the token **or** a verifiable JWT). `/api/metrics` is always under the `/api` gates. `envFlag` grammar; an unrecognised value counts as OFF |
| `SAMMY_MAX_BODY_BYTES` | server | largest request body buffered on trigger ingress (default 5 MiB; `413` beyond it) — with `SAMMY_POLL_TIMEOUT_MS` / `SAMMY_POLL_MAX_BODY_BYTES` in [`triggers.md`](triggers.md) |
| `SAMMY_CRON_FAILURE_THRESHOLD` | server | consecutive failed cron fires before the breaker trips (default 3) |
| `SAMMY_CRON_AUTO_PAUSE` | server | `1` → the tripped breaker also pauses the cron (default: a loud alert only) |
| `SAMMY_A2A_SIGNING_KEY` | server | RSA private key PEM — served A2A agent cards carry a JWS signature |
| `SAMMY_A2A_REMOTE_PUBLIC_KEY` | server, worker | pinned publisher key — fetched A2A cards must verify against it (fail closed) |
| `SAMMY_SERVER_URL` | worker | delegate mode — POST runs to this server instead of executing in-process |
| `SAMMY_WORKER_CONCURRENCY` | worker | concurrent deliveries per worker |
| `SAMMY_WORKER_HTTP_TIMEOUT_MS` | worker | delegate-mode `POST /api/runs/start` timeout (default 30 s) — a hung server would otherwise hold the claim open |
| `SAMMY_WORKER_SHUTDOWN_GRACE_MS` | worker | how long SIGTERM waits for in-flight deliveries before exiting anyway (default 15 s) |
| `SAMMY_MAX_QUEUE_DEPTH` / `SAMMY_MAX_INFLIGHT_PER_ORCH` / `SAMMY_MAX_EVENT_CHAIN_DEPTH` | server, worker | ingress / fairness / loop guards (see [`triggers.md`](triggers.md)) |
| `SAMMY_DISABLE_INPROCESS_WORKER` | server | stop the server from draining deliveries itself (dedicated workers own the queue) |
| `SAMMY_CONNECTIONS_FILE` | server, worker | keep `credentials.json` outside the repo |
| `SAMMY_MAX_DIGEST_RUNS` | server | how many most-recent runs `/api/observability` and `/api/cost` hydrate events for (default 2000); older runs roll off the digest rather than risk the process |
| `SAMMY_ALLOW_CODE_RUN` | server, worker | `1` → enable `code.run` shell phases (off by default; trusted workspaces only) |
| `SAMMY_CODE_RUN_ALLOW` | server, worker | allowlist mode for `code.run`: newline- or `;`-separated patterns (`*` wildcards) the resolved command must match; a match runs WITHOUT a shell. Ignored when `SAMMY_ALLOW_CODE_RUN` is on |
| `SAMMY_AGENT_AMBIENT_MCP` | server, worker | `1` lets agents also use the MCP servers of the host's own Claude configuration and account connectors. Off by default: an agent reaches only the servers its phase names in `mcp`, so a run behaves the same on every machine and a read-only step cannot write through a personal connector |
| `SAMMY_REPO_ROOTS` | server, worker | path-delimited directories searched for a local clone when a `worktrees` repo is a URL; the first is where the Run dialog's clone lands. Default `~/git`, `~/src`, `~/code`, `~/projects`, `~/Developer` and the workspace's parent (existing ones) |
| `SAMMY_GIT_USER_NAME` / `SAMMY_GIT_USER_EMAIL` | server | the git identity set (repo-local `user.name` / `user.email`) in a repository sammy-pack clones from the Run dialog, so commits its runs make are not attributed to the machine's global identity |
| `SAMMY_GH_CLI_FALLBACK` | server | a `github` input (or a jira input given a GitHub link) with no GitHub connection uses the server's own `gh auth token` — the operator's identity. Default: on for a single-user install, off when a JWT verifier or read-only roles are configured; `1` / `0` force it |
| `SAMMY_CODE_RUN_ENV` | server, worker | names (comma / space separated) a `code.run` command may inherit from the server environment, on top of `PATH`, `HOME`, temp dir and locale; unset = inherit everything |
| `SAMMY_ARTIFACT_MAX_BYTES` / `SAMMY_ARTIFACT_RUN_MAX_BYTES` | server, worker | cap on one `code.artifact` command log (tail kept; default 256 KiB) / on all of one run's artifacts (default 8 MiB) |
| `SAMMY_HTTP_ALLOWED_HOSTS` | server, worker | hosts every `http` node may call (comma / space separated; `*.example.com` for subdomains), in addition to a node's own `allowHosts` |
| `SAMMY_SCRUB_SALT` | server | salt for a trigger `scrub.hashFields` digest; unset → those fields are dropped instead of hashed |
| `SAMMY_WORKTREE_DIR` | server, worker | where root `worktrees` are checked out (default `<root>/.worktrees`) |
| `SAMMY_PUBLIC_URL` | server | the app's public base URL — `notify.onGate` envelopes link to it |
| `SAMMY_MAX_AGENT_TOKENS` | server, worker | default per-agent cost-weighted token ceiling |
| `SAMMY_ALLOWED_MCP_TOOLS` / `SAMMY_HEADLESS_TOOL_DENY` | server, worker | headless auto-approve list / fail fast on permission-gated tools |
| `SAMMY_HEALTH_PROBE` | server | `1` → boot-time agent-tools probe reported by `/api/health` |
| `SAMMY_OTLP_ENDPOINT` / `SAMMY_OTLP_HEADERS` | server, worker | opt-in OTLP/HTTP collector; each run's trace is pushed at terminal |
| `SAMMY_BASE_URL` | `sammy-cli.ts` | server the thin HTTP CLI talks to (default `http://localhost:5173`; `--base` overrides) |
| `SAMMY_ORCH_DIR` | `@sammy-pack/cli`, MCP | where `list_orchestrations` looks (default `./orchestrations`, then `./examples`) |
| `SAMMY_RUN_DB` | `@sammy-pack/cli`, MCP | explicit `runs.db` file path for the standalone CLI's store (its directory becomes the store root) |
| `SAMMY_DRY_RUN` | `@sammy-pack/cli` | `1` → print the argv the CLI would exec instead of exec'ing it (same as `--print-argv`) |
