# syntax=docker/dockerfile:1
#
# sammy-pack — one image, two entrypoints.
#
#   Server (default CMD): the standalone http server (app/serve.ts) — full API
#   (REST, SSE, triggers, A2A) + the built SPA from web-dist/.
#   Worker: the standalone delivery worker (app/worker.ts) — run the SAME image
#   with a different command:
#
#     docker build -t sammy-pack .
#     docker run --init -p 5173:5173 -v sammy-data:/data sammy-pack
#     docker run --init --no-healthcheck -v sammy-data:/data sammy-pack \
#       node --import tsx worker.ts
#
# Layout: code lives in the image at /app (replaced on every upgrade); the
# workspace — orchestrations, agents, schema, datasets, evals, context, and
# runtime state (runs.db, budget.json, credentials.json) — lives at /data
# (SAMMY_REPO_ROOT). Mount a named volume at /data: Docker seeds it from the
# image's baked workspace on first use, and state persists across upgrades.
#
# Env (see docs/DOCKER.md and docs/deployment.md for the full reference):
#   required for agent execution : ANTHROPIC_API_KEY (or a credentials.json
#                                  connection at /data/credentials.json)
#   recommended                  : SAMMY_API_TOKEN (bearer gate on mutating /api)
#   optional                     : DATABASE_URL (Postgres store; unset = SQLite
#                                  at /data/runs.db), SAMMY_WEBHOOK_SECRET,
#                                  SAMMY_RUN_RETENTION_DAYS, SAMMY_AUTO_RESUME,
#                                  SAMMY_DISABLE_INPROCESS_WORKER, PORT,
#                                  SAMMY_WORKER_CONCURRENCY, SAMMY_SERVER_URL, …
#
# serve.ts / worker.ts are TypeScript executed via tsx — exactly how the repo's
# own `npm run serve` / `npm run worker` scripts run them. The image ships tsx
# rather than precompiling; tradeoff documented in docs/DOCKER.md.

# ─── Stage 1: build ──────────────────────────────────────────────────────────
# Full (non-slim) node: toolchain for native deps (better-sqlite3) if no
# prebuild matches, and git for the harmless root `prepare` script.
FROM node:22-bookworm AS build

WORKDIR /repo/app

# Manifests first so the dependency layer caches across source edits.
# packages/ must be present before `npm ci`: they are npm workspaces, and
# @sammy-pack/sdk compiles its dist/ via a `prepare` script during install.
COPY app/package.json app/package-lock.json ./
COPY app/packages ./packages
RUN npm ci

# App source (node_modules / web-dist / ios / android excluded by .dockerignore).
COPY app/ ./

# Build the SPA the standalone server serves from web-dist/.
RUN npm run build:web

# Slim node_modules to what runtime needs: production deps + tsx.
# `npm prune` keeps better-sqlite3's compiled binding (a prod dep) and the sdk
# workspace dist/ built above. tsx is a devDependency (pruned), so re-add it at
# the exact range package.json pins; --ignore-scripts stops the reinstall from
# re-running workspace prepare scripts whose build tools were just pruned.
RUN npm prune --omit=dev \
 && npm install --no-save --ignore-scripts \
      "tsx@$(node -p "require('./package.json').devDependencies.tsx")"

# ─── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# SAMMY_BIND_HOST: a container must bind every interface or the published port
# never reaches it. serve.ts defaults to LOOPBACK (so a local `npm run serve`
# is not silently on the network); the image opts in explicitly, which keeps
# "exposed on all interfaces" a greppable decision rather than the default.
ENV NODE_ENV=production \
    SAMMY_REPO_ROOT=/data \
    PORT=5173 \
    SAMMY_BIND_HOST=0.0.0.0

# `ps` — src/server/reap.ts reads the process table (`ps -Ao pid=,ppid=`) to
# find agent/code.run grandchildren that were reparented away from the run and
# would otherwise leak for the container's lifetime. node:*-slim ships no
# procps, so `readProcessTable()` threw ENOENT, `descendantPids` logged one
# warning and returned empty, and the leak the module exists to fix was
# unfixed in production. `--init` reaps zombies; it does not kill reparented
# grandchildren.
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps \
 && rm -rf /var/lib/apt/lists/*

# Code — image-owned, never on a volume, so upgrades always take effect.
COPY --from=build --chown=node:node /repo/app /app

# Generic workspace seed — named volumes mounted at /data are initialized from
# this content on first use. /data itself must be writable by the app user:
# runs.db, budget.json, runs/, memory-store/ are created here at runtime.
RUN mkdir -p /data && chown node:node /data
COPY --chown=node:node schema/   /data/schema/
COPY --chown=node:node agents/   /data/agents/
COPY --chown=node:node examples/ /data/examples/
COPY --chown=node:node datasets/ /data/datasets/
COPY --chown=node:node evals/    /data/evals/
COPY --chown=node:node context/  /data/context/

WORKDIR /app
USER node
EXPOSE 5173

# Server health. Worker containers run no http listener — disable there
# (compose: `healthcheck: disable`, docker run: `--no-healthcheck`).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5173)+'/api/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# `node --import tsx` = the same tsx runtime as `npm run serve`, minus the npm
# wrapper so SIGTERM reaches the process directly (serve.ts handles shutdown).
CMD ["node", "--import", "tsx", "serve.ts"]
