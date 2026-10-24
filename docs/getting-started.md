# Getting started

Clone → first run in about five minutes. Everything here uses only what ships
in this repo.

## Prerequisites

- **Node.js 22 LTS** (`.nvmrc` pins it — run `nvm use`) and npm.
- **Claude Code CLI logged in** — the server-owned run path dispatches agents
  via the Claude Agent SDK, which reads your CLI login from `~/.claude/`.
  Run `claude` once in a terminal to confirm; no separate API key needed.
  (Other providers — OpenAI / Gemini / Bedrock — can be keyed per-node later
  via Settings; agentic tool-use phases run through the Claude Agent SDK.)

## Install and launch

```bash
cd app
npm install
cd ..
./sammy-pack start        # helper script: start | stop | restart | status | logs
```

`./sammy-pack start` launches the dev server (default port 5173, auto-bumps if
busy) and backgrounds it; `./sammy-pack logs` tails it. If you prefer the
foreground: `cd app && npm run web`.

Open the printed URL — you land on the **Pipelines** page with the shipped
example orchestrations.

## First run — zero tokens

`smoke-test` is a three-phase orchestration of pure-JS `code` nodes: no LLM
calls, no cost. It proves the engine, the run store, and event streaming work
end-to-end.

**From the UI:** Pipelines → `smoke-test` → Run. Watch the three phases stream
in the run dock.

**From the API:**

```bash
curl -s -X POST localhost:5173/api/runs/start \
  -H 'Content-Type: application/json' \
  -d '{"orchestrationName": "smoke-test", "initialInput": "sammy"}'
# → {"id": "<run-id>"}

curl -N localhost:5173/api/runs/<run-id>/events     # SSE: live event stream
```

The run survives a tab close and a server restart — the server owns execution,
the browser is just an observer.

## First multi-agent run

`refinement-loop` is a draft → critique → revise loop. The agents it needs
(`writer`, `critique`) ship in `agents/`, so it runs with no setup:

Pipelines → `refinement-loop` → Run. Each phase shows its cost, duration, and
model in the run view. Other good starters: `fanout-summarize` (parallel map),
`decision-tree` (routing), `multi-agent-dialog` (conversation).

## The Runs page

Every run — live or historical — lives on the **Runs** page:

- **Stream** — phases and deltas arrive over SSE; reconnect-safe.
- **Approve** — a `lock: true` phase pauses the run (amber status) until you
  approve it, here or in the Pipelines run dock.
- **Pause / resume** — resume re-runs from the last checkpoint, skip-replaying
  completed phases at zero tokens.
- **Cancel** — aborts the SDK subprocess mid-call.
- **Fork** — branch a finished run at any phase: completed leaves replay from
  checkpoint, execution continues fresh from there.

## Run the same JSON from the Claude CLI

The CLI skill at `.claude/skills/sammy-pack/SKILL.md` executes the same
orchestration files inside a Claude Code session — no server, no API key:

```
claude                            # in this repo
> /sammy-pack run refinement-loop
> run ticket-to-pr for JIRA-123
```

Lock gates become interactive approval prompts. A parity test
(`app/__tests__/cli-parity.test.ts`) enforces that the CLI and the web
executor support the identical schema surface.

## Author your own orchestration

Three ways, all producing the same JSON artifact:

1. **Start from an example.** Duplicate anything in `examples/` and edit it in
   any of the four editors — Pipeline (linear), Graph (node canvas), Tree, or
   raw JSON. All four are projections of the same file.
2. **Generate from a spec.** Pipelines → New → paste a PRD or requirements
   doc; the designer agent emits an orchestration.
3. **Drop a diagram.** Drag in a `.drawio`, `.excalidraw`, PDF, image, or text
   file. The file is parsed (diagrams to a node→edge list, images via vision),
   converted to an orchestration, and each phase is fuzzy-matched against your
   `agents/` directory — unmatched agents can be generated in one click.

The node kinds and decorators are specified in [`schema.md`](schema.md);
common shapes (fan-out, converge, refinement loops, routing) are cataloged in
[`patterns.md`](patterns.md). Saved files validate against
`schema/orchestration.schema.json`.

## Add a new orchestration — step by step

A repeatable checklist for adding one by hand. Every step is
domain-agnostic — `sammy-pack` is a generalized framework, so nothing
app-, company-, or deployment-specific should land in a committed file.

1. **Design the shape first.** Decide whether it's a sequential pipeline,
   fan-out, converge, refinement loop, or routing tree *before* writing JSON.
   The catalog in [`patterns.md`](patterns.md) names each shape — pick the one
   that matches and adapt it.
2. **Create `examples/<name>.json`.** Easiest start: copy the generic
   [`examples/TEMPLATE.json`](../examples/TEMPLATE.json) (walkthrough in
   [`examples/TEMPLATE.md`](../examples/TEMPLATE.md)) or any existing example,
   then set `name` to `<name>` (lowercase, matching the filename) and rewrite
   `description`. Keep machine-/environment-specific values in `vars`, not
   hard-coded.
3. **Reference agents.** Point each `agent` / `agents[]` / `route.router` /
   `loop.judge` at a file in [`../agents/`](../agents). Reuse the generic
   starters that ship there; if you add a new one, keep it generic and add its
   `!name.md` allowlist entry (see [Author an agent](#author-an-agent)).
4. **Test it.** Run it from the web UI (Pipelines → your orchestration → Run)
   or the CLI (`/sammy-pack run <name>`). Start with cheap phases; watch the
   event stream in the run view.
5. **Validate against the schema.** Saved files validate against
   `schema/orchestration.schema.json` (the editors flag errors inline, and the
   CLI/web executor parse against the same surface). Fix every error before
   committing.
6. **Before committing — guardrails.** This is mandatory, not optional:
   - **Scan for domain content.** No app/company names, screen names,
     personas, credentials, hostnames, or device IDs — anywhere in the JSON.
   - **Run the gotchas + preflight checklist** in
     [`AUTHORING_ORCHESTRATIONS.md`](AUTHORING_ORCHESTRATIONS.md) §10–11
     (interpolation, fan-out sizing, failure mode per phase, token ceilings…).
   - **Stage by explicit path and run the pre-commit scan** from
     [`../AGENTS.md`](../AGENTS.md) §5: `git add examples/<name>.json` (never
     `git add -A`), then review the staged diff for any secret / PII / domain
     string before you commit. To ship it as a shipped example, also add a
     `!<name>.json` entry to [`../examples/.gitignore`](../examples/.gitignore).

## Author an agent

An agent is one markdown file in `agents/` — frontmatter plus a system prompt:

```markdown
---
name: release-notes-writer
description: Turns a merged-PR list into customer-facing release notes.
input:  { kind: text }
output: { kind: text }
tools:  [Read, WebFetch]
---

# release-notes-writer

You write concise, customer-facing release notes...
```

See [`../agents/README.md`](../agents/README.md) for the full format, the
template agents that ship, and how to import agent sets from another
workspace (Settings → Agent sources).

## Datasets and evals

- **Datasets** — labeled rows for eval runs. `quickstart-summarize` ships;
  rows can be hand-edited or AI-generated on the Datasets page.
- **Evals** — run an orchestration over a dataset with scorers (exact, regex,
  LLM-judge) and drill into per-row results on the Evals page.
- **A/B compare** — two orchestrations, one dataset, side-by-side cost /
  latency / quality.

For measuring and improving LLM-judge agents specifically, see
[`calibration.md`](calibration.md). For retrieval, compaction, and cross-run
memory patterns, see [`context-engineering.md`](context-engineering.md).

## Where things live

| Path | What it is |
| --- | --- |
| `examples/*.json` | Orchestrations — the single source of truth both surfaces run |
| `agents/*.md` | Agent definitions (markdown + frontmatter) |
| `schema/orchestration.schema.json` | The JSON Schema every orchestration validates against |
| `datasets/`, `evals/` | Eval datasets and eval configs |
| `runs.db` | SQLite run store (gitignored; Postgres opt-in via `DATABASE_URL`) |
| `budget.json` | Daily / monthly USD spend caps (editable in Settings) |
| `credentials.json` | Named credentials registry (gitignored; template in `credentials.example.json`) |

## Next steps

- Fire runs from the outside world — webhooks, cron, polling, queues:
  [`triggers.md`](triggers.md)
- Run it as a standalone server / worker, add auth, set spend caps:
  [`deployment.md`](deployment.md)
- Call remote agents and expose your orchestrations to other systems:
  [`a2a.md`](a2a.md)
- How the engine actually works: [`architecture.md`](architecture.md)
