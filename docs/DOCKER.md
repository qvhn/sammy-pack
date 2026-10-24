# Docker — containerized server + worker

One image, two entrypoints. The default command runs the **standalone server**
(`app/serve.ts` — full API + the built SPA); the same image runs the
**delivery worker** (`app/worker.ts`) with a different command. Both are
described in [`deployment.md`](deployment.md); this page covers only the
container packaging.

## Image layout

| Path | Contents | Ownership |
| --- | --- | --- |
| `/app` | code: `serve.ts`, `worker.ts`, engine, `web-dist/` SPA, `node_modules` | **image** — replaced on every upgrade |
| `/data` | workspace (`SAMMY_REPO_ROOT`): `schema/`, `agents/`, `examples/`, `datasets/`, `evals/`, `context/`, plus runtime state — `runs.db` (SQLite mode), `budget.json`, `credentials.json`, `runs/`, `memory-store/`, `mcp/servers.json` | **volume** — seeded from the image on first use, survives upgrades |

Mount a **named volume** at `/data`: Docker initializes an empty named volume
from the image's baked workspace, so the bundled examples/agents/schema appear
on first boot and everything written afterwards persists. The container runs
as the non-root `node` user.

> **Build from a clean clone.** `agents/` and `examples/` are git *allowlist*
> directories — a working tree may hold imported, untracked sets that
> `.dockerignore` cannot tell apart from the shipped generic files. CI or a
> fresh `git clone` is the only safe build context.

## Topology 1 — single node, SQLite (default)

```sh
docker compose up --build -d
# UI + API on http://localhost:5173
```

One `server` container: SQLite store at `/data/runs.db`, in-process delivery
worker draining the trigger queue. **Do not** point a standalone worker at the
SQLite volume — SQLite delivery claims are single-process by design (the
`worker` service is postgres-profile-only for exactly this reason; a further
tell: against SQLite an idle standalone worker's poll timers are all unref'd,
so with no TTY the process simply exits 0 after boot).

Without compose:

```sh
docker build -t sammy-pack .
docker run -d --init -p 5173:5173 -v sammy-data:/data \
  -e ANTHROPIC_API_KEY=… -e SAMMY_API_TOKEN=… sammy-pack
```

(`--init` matters: agent runs spawn child processes that need reaping.)

## Topology 2 — N servers + M workers, Postgres

Safety across processes comes from Postgres (`FOR UPDATE SKIP LOCKED` claims,
per-run leases + fencing — see [`deployment.md`](deployment.md)). Put the
switches in a `.env` next to `docker-compose.yml`:

```sh
# .env
COMPOSE_PROFILES=postgres
DATABASE_URL=postgres://sammy:sammy@postgres:5432/sammy
SAMMY_DISABLE_INPROCESS_WORKER=1   # dedicated workers own the queue
POSTGRES_PASSWORD=change-me        # keep in sync with DATABASE_URL
```

```sh
docker compose up --build -d --scale worker=3
```

That starts `postgres`, one `server` (API/UI/SSE only), and three `worker`
replicas executing runs directly against the shared store. Notes:

- Scaling `server` past 1 needs distinct published ports or a load balancer in
  front (`SAMMY_PUBLISH_PORT` moves the single published port).
- Delegate mode instead of direct execution: set
  `SAMMY_SERVER_URL=http://server:5173` (workers then POST `/api/runs/start`
  to the server, which owns execution; give them `SAMMY_API_TOKEN` if set).
- Multi-*host* deployments need the `/data` workspace shared or identically
  baked per node — orchestrations/agents are read from the filesystem per run,
  and edits made through the API land on the local `/data` only.
- Running the worker image manually: add `--no-healthcheck` (the image
  healthcheck probes the http server, which a worker doesn't run).
- In this topology the server only accepts; the workers execute, and they
  own the concurrency gate's queue too: a fire parked behind a busy `queue`
  group is released by the worker that finishes the holder (or reclaims it,
  or cancels it under `cancel-existing`) as a `concurrency-drain` delivery
  into the trigger queue, visible in the deliveries list like any other.
  Nothing here depends on the server being up to drain.
- A misconfigured `DATABASE_URL` (a closed port, a wrong host) is a **fatal
  boot**: the container logs `[serve] fatal:` and exits 1, and under
  `restart: unless-stopped` it crash-loops — Docker reports it `unhealthy`
  because it never reaches the healthcheck's start period. `/api/readyz`
  answering 503 is only for a store that fails *after* boot.

## Environment variables

The ones that matter in a container. The full reference lives in
[`deployment.md`](deployment.md).

| Variable | Used by | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | server, worker | auth for agent execution via the Claude Agent SDK (alternative: an `anthropic` connection in `/data/credentials.json`). `OPENAI_API_KEY` / `GEMINI_API_KEY` likewise for `llm` nodes on other providers |
| `SAMMY_API_TOKEN` | server, worker (delegate) | bearer gate on mutating `/api` routes — set it whenever the port is reachable by others |
| `DATABASE_URL` | server, worker | Postgres run store; unset/empty → SQLite at `/data/runs.db` |
| `PORT` / `SAMMY_PORT` | server | bind port (image default `5173`) |
| `SAMMY_REPO_ROOT` | server, worker | workspace root — preset to `/data` in the image; rarely changed |
| `SAMMY_WEBHOOK_SECRET` | server | HMAC secret for signed trigger ingress (webhook/events/queue/deploy) |
| `SAMMY_REQUIRE_SIGNED_TRIGGERS` | server | on (`1/true/yes/on`) → refuse any unsigned HTTP-fired trigger at fire time. An unrecognised value warns once and counts as ON (fails closed) |
| `SAMMY_REQUIRE_AUTH_READS` | server | on (`1/true/yes/on`; unrecognised = ON; unset or empty = OFF) → gate reads too (SSE stream, root `/metrics` and the root A2A agent card included); the precondition for owner scoping to be a control. The bearer token and a JWT verifier compose: either satisfies the gate |
| `SAMMY_METRICS_PUBLIC` | server | on (`1/true/yes/on`; unrecognised = OFF) → keep the root `/metrics` scrape open under gated reads |
| `SAMMY_RUN_RETENTION_DAYS` | server | opt-in retention sweep — delete terminal runs and terminal deliveries older than N days (forgets their idempotency keys and polling watermarks); unset = keep forever. The delete re-checks the status, so a run resumed mid-sweep survives with its events |
| `SAMMY_AUTO_RESUME` | server | `1` / `true` → also resume the runs the orphan scan marks `interrupted` — resume first, then drain only the groups whose run did not resume. **Off by default** — they wait for a manual Resume; the worker never resumes in any mode (it marks and drains) |
| `SAMMY_DISABLE_INPROCESS_WORKER` | server | `1` / `true` (literal — not the `envFlag` grammar, so `yes` is silently off) → server stops draining deliveries itself (dedicated workers own the queue) |
| `SAMMY_SERVER_URL` | worker | delegate mode — POST runs to this server instead of executing in-process |
| `SAMMY_WORKER_CONCURRENCY` | worker | concurrent deliveries per worker (default 4) |
| `SAMMY_MAX_INFLIGHT_PER_ORCH` | server, worker | per-orchestration dispatch fairness cap |
| `SAMMY_ALLOW_CODE_RUN` | server, worker | `1` / `true` → enable `code.run` shell phases (**off by default**; trusted workspaces only) |
| `SAMMY_CODE_RUN_ALLOW` | server, worker | allowlist mode for `code.run`: newline- or `;`-separated patterns (`*` wildcards) the resolved command must match; a match runs WITHOUT a shell. Ignored when `SAMMY_ALLOW_CODE_RUN` is on |
| `SAMMY_CODE_RUN_ENV` | server, worker | names (comma / space separated) a `code.run` command may inherit from the server environment, on top of `PATH`, `HOME`, temp dir and locale; unset = inherit everything |
| `SAMMY_ARTIFACT_MAX_BYTES` / `SAMMY_ARTIFACT_RUN_MAX_BYTES` | server, worker | cap on one `code.artifact` command log (tail kept; default 256 KiB) / on all of one run's artifacts (default 8 MiB) |
| `SAMMY_HTTP_ALLOWED_HOSTS` | server, worker | hosts every `http` node may call (comma / space separated; `*.example.com` for subdomains), in addition to a node's own `allowHosts` |
| `SAMMY_SCRUB_SALT` | server | salt for a trigger `scrub.hashFields` digest; unset → those fields are dropped instead of hashed |
| `SAMMY_WORKTREE_DIR` | server, worker | where root `worktrees` are checked out (default `<root>/.worktrees`) |
| `SAMMY_PUBLIC_URL` | server | the app's public base URL — `notify.onGate` envelopes link to it |
| `SAMMY_MAX_AGENT_TOKENS` | server, worker | default per-agent token ceiling |
| `SAMMY_ALLOWED_MCP_TOOLS` / `SAMMY_HEADLESS_TOOL_DENY` | server, worker | headless auto-approve list / fail-fast on permission-gated tools |
| `SAMMY_CONNECTIONS_FILE` | server, worker | credentials file override (default `/data/credentials.json`) |
| `SAMMY_CRON_AUTO_PAUSE` | server | `1` → auto-pause a repeatedly-failing cron trigger |
| `SAMMY_HEALTH_PROBE` | server | `1` / `true` → boot-time agent-tools probe reported by `/api/health` |
| `SAMMY_MAX_QUEUE_DEPTH` / `SAMMY_MAX_EVENT_CHAIN_DEPTH` | server, worker | ingress / event-loop guards ([`triggers.md`](triggers.md)) |
| `SAMMY_JWT_*`, `SAMMY_JWKS_URI`, `SAMMY_A2A_*` | server | JWT verification and A2A card signing — table in [`deployment.md`](deployment.md) |
| `SAMMY_OTLP_ENDPOINT` / `SAMMY_OTLP_HEADERS` | server | opt-in OTLP/HTTP collector (base URL or full `/v1/traces`); each run's trace is pushed at terminal with `gen_ai.*` attributes. Prometheus exposition is always served at `/metrics`; under `SAMMY_REQUIRE_AUTH_READS=1` the scrape needs the bearer / JWT unless `SAMMY_METRICS_PUBLIC=1` |

Secrets that live in files: drop a `credentials.json` into the volume
(`docker cp credentials.json <server>:/data/` or a bind/secret mount +
`SAMMY_CONNECTIONS_FILE`). Same for a machine-specific `/data/mcp/servers.json`
MCP registry — neither is ever baked into the image.

## Not a Kubernetes target

The image runs anywhere a container runs, but nothing here is tested on
Kubernetes and two things on this page are Docker-specific:

- **The `/data` seed is Docker named-volume behaviour.** Docker copies the
  image's baked workspace into an *empty named volume* on first use. A
  PersistentVolumeClaim starts empty and nothing copies the bundled
  `examples/` / `agents/` / `schema/` in — you would mount the workspace
  yourself (init container, ConfigMap, or a pre-populated volume).
- **`/api/readyz` says READY on an empty workspace.** It probes the run store
  only, so a pod with an unpopulated `/data` passes readiness and then fails
  every run with "orchestration not found". Point readiness at the store and
  verify the workspace separately.

Treat the compose topologies above as the supported shape; a Kubernetes
deployment is yours to validate.

## Volumes & upgrades

- **Code upgrades always take effect** — code lives in the image at `/app`,
  never on the volume. `docker compose build --pull && docker compose up -d`.
- **The workspace volume is seeded once — and only when it is empty.** Docker
  copies the image's baked `/data` into a named volume at first mount *only
  if the volume has nothing in it*. A new image's bundled
  `examples/`/`agents/`/`schema/` therefore never overwrite an existing
  `/data` volume (your edits and state are what persists), and a volume you
  provisioned by hand — even with a single file in it — is never seeded at
  all: the server boots with an empty orchestration list, not the examples.
  The image's smoke suite pins both behaviours. To pick up newly bundled
  content: copy it in manually (`docker compose cp server:/… `-style, or
  `docker run --rm -v sammy-data:/data sammy-pack cp -rn /data/... `), or start
  a fresh volume and re-import your own orchestrations.
- **A hand-made volume needs the image's uid.** The first-use seed copies
  files as `node:node`; a volume root you created through another container
  is owned by whoever created it (usually root), and the non-root `node` user
  then cannot create `runs.db` in it. `chown -R 1000:1000` the volume before
  the first start.
- SQLite mode: back up by snapshotting the `sammy-data` volume while the
  server is stopped (WAL side files included). Postgres mode: a normal
  `pg_dump` against the **`postgres`** service —
  `docker compose exec postgres pg_dump -U sammy sammy` — whose data lives on
  the `sammy-pg` *volume* (`sammy-pg` is a volume name, not a service: there
  is nothing to `exec` into under that name). The `sammy-data` volume then
  holds only workspace files.

## Why the image ships `tsx` (not precompiled JS)

`serve.ts` / `worker.ts` are TypeScript entrypoints executed via `tsx`
everywhere the repo runs them — the `npm run serve` / `npm run worker`
scripts, and CI, which builds only the SPA (`npm run build:web`), never a
server bundle. The image does the same: production `node_modules` plus `tsx`,
started as `node --import tsx serve.ts`. Tradeoff: a few extra MB
(tsx + esbuild) and a sub-second transpile at boot, in exchange for zero drift
from how the repo actually runs and no second build pipeline to maintain.
Precompiling (tsc/bundler) would shave that startup cost but introduces a
server build config the repo deliberately doesn't have.
