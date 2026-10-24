# Contributing

Thanks for looking. A few things about this repo are unusual enough to be
worth reading before you open a PR.

## Read `AGENTS.md` first

[`AGENTS.md`](./AGENTS.md) holds the prime directive: **everything committed
here stays domain-agnostic.** No app, company or deployment-specific content —
not in code, tests, fixtures, docs, example JSON, or screenshots. The rule of
thumb it gives is the one that matters: *if swapping in a different app would
require editing the committed file, it isn't generic yet* — move the specific
part into `vars` or run inputs.

Two consequences that catch people out:

- `agents/` and `examples/` use **allowlist** `.gitignore`s. Dropping a file in
  does not stage it. Shipping a new generic template means adding the file *and*
  its `!name` entry. Never `git add -A`.
- A **screenshot captures your working tree**, which may legitimately contain
  gitignored domain content. Take images for the docs from a clean clone.

## Setup

```bash
cd app
npm ci
npm run web       # the dev server + UI (vite, with the API plugin)
npm run cli       # the CLI
```

## The gate

```bash
cd app
npm run lint && npm run ci   # lint + typecheck + tests + web build
```

Both halves, because CI runs them as separate required steps and `npm run ci`
is only the second three (`typecheck && test && build:web`). The lint step
gates the *error* class only — the warning count is large and historically
tolerated — and the rule that has actually caught bugs here is
`react-hooks/exhaustive-deps`, which has tracked real stale-closure defects in
the editors. Running `npm run ci` alone can open a PR that fails CI on a rule
you never saw locally.

Two test groups need containers and **skip cleanly without them**:

```bash
docker compose -f docker-compose.test.yml up -d --wait
cd app
npm run test:integration   # Kafka / RabbitMQ / SQS adapters vs real brokers
npm run test:postgres      # the Postgres store contract + the full path on PG
docker compose -f docker-compose.test.yml down -v
```

Run both if you touch a queue-source adapter or anything under
`src/server/*store*`. The store layer is written once per backend and the SQL
diverges exactly where reliability lives, so a Postgres-only mistake
typechecks fine and only surfaces by running it.

A third group smokes the **shipped container** over HTTP — the Dockerfile's
runtime stage, the `/data` seed, a `docker restart` and a SIGTERM with a run
parked at a durable wait (exit 0, row intact, the signal still lands), a
pre-existing volume that must *not* be re-seeded, an unreachable
`DATABASE_URL` (fatal boot, never healthy), and the server + worker Postgres
topology — under the hardened posture (bearer token, gated reads, a read-only
identity). The assertions are pinned, not fuzzy: `readyz` must name the
Postgres backend, the identity-spoof case must be exactly 401, and an
anonymous fire must land as `system`. Build from `git archive`, never from
the working tree (`agents/` and `examples/` may hold untracked imported
content that .dockerignore cannot tell apart):

```bash
git archive --format=tar HEAD | docker build -t sammy-pack:smoke -
docker compose -f docker-compose.test.yml up -d --wait postgres
cd app && TEST_DOCKER_IMAGE=sammy-pack:smoke npm run test:docker
```

Run it if you touch the Dockerfile, `serve.ts`, `worker.ts`, or any of the
auth / ingress gates in `sammy-pack-api.ts`. The Postgres topology (B) skips
unless `TEST_DOCKER_PG_URL` is set, so run it with the compose Postgres up.
Not every container case is covered. The notable one is auto-resume after a
SIGKILL mid-leaf, left out deliberately and documented in a comment where it
would have gone: the dead process's lease stays valid for the 120 s
`DEFAULT_LEASE_TTL_MS` constant before anything may reclaim it, so a container
test would have to idle through it — and that seam is covered in-process by
`lifecycle-crash-recovery.test.ts` instead. CI runs all three groups.

## What a good change looks like here

- **Test the failure, not just the feature.** The failure class that matters
  most here is the silent stall — work stops, or a guarantee goes unenforced,
  while every status surface still reports healthy. A happy-path test catches
  none of them. Two questions find them: *would anything say so?* and *what
  enforces this?*
- **Verify the test fails without the fix.** Revert your change and confirm the
  new test goes red. An assertion that passes either way is worse than no test:
  it reports a guarantee nothing is holding.
- **Don't let a mock define the contract.** A mock written beside its interface
  silently becomes the spec. If a module exists to talk to something external,
  test it against the real thing at least once.
- **Parity tests are load-bearing.** `cli-parity`, `schema-parity` and
  `preview.structure` exist so the schema, the CLI skill, the dry-run preview
  and the live executor cannot drift apart. If one fails, fix the drift rather
  than the assertion.
- **Keep comments about constraints, not narration.** Say why something must be
  this way; the diff already shows what changed.

## Commits

Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`),
with a body explaining *why* when the reason isn't obvious from the diff.

## Reporting a bug

Include the orchestration JSON (reduced if you can), what you expected, what
happened, and the relevant run id or trigger. For anything security-related,
use [`SECURITY.md`](./SECURITY.md) instead of a public issue.
