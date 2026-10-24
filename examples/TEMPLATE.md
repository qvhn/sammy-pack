# TEMPLATE.json — a domain-agnostic starter orchestration

A minimal, **generic** orchestration you copy as the starting point for a new
one. It exercises the common moving parts (vars, a deterministic `code` phase,
an `agent` phase, a fan-out `map`, a nested `subflow`, a `trigger`, a `budget`,
and `lifecycle`) so you can delete what you don't need rather than assemble
from scratch.

> **Before you edit it — read [`../CLAUDE.md`](../CLAUDE.md) and
> [`../AGENTS.md`](../AGENTS.md).** `sammy-pack` is a generalized, open
> framework: nothing app-, company-, or deployment-specific may land in a
> committed orchestration. Keep the name, prompts, and logic domain-agnostic;
> push anything machine- or environment-specific into `vars` (or run `inputs`)
> rather than hard-coding it. `examples/` is an allowlist — your own
> orchestration is gitignored by default unless you add a `!name.json` entry,
> which you should only do once it's confirmed generic.

## How to use it

1. Copy it to a new name: `cp examples/TEMPLATE.json examples/<your-name>.json`.
2. Change `name` to `<your-name>` (lowercase, matches the filename) and rewrite
   `description`.
3. Keep the phases you need, delete the rest, and wire your own `agents/`.
4. Validate, then run it — see the
   [getting-started checklist](../docs/getting-started.md#add-a-new-orchestration).

## The fields, one by one

| Field | What it is |
| --- | --- |
| `$schema` | Points editors/validators at `schema/orchestration.schema.json` so you get completion + inline errors. Keep it. |
| `name` | Unique id; lowercase, matches the filename. Both the web UI and the CLI resolve an orchestration by this name. |
| `description` | Free text. In a *real* file this describes the flow; in the template it carries the guardrail reminder. Rewrite it. |
| `lifecycle` | Metadata: `tags` for grouping; optional `stage` (must be `dev` \| `staging` \| `prod`), `deprecated`, `errorOrchestration`. Tags only here — `template` marks this as the starter. |
| `vars` | Top-level constants, read anywhere as `${vars.x}`. Put machine- / environment-specific values here (paths, ids, thresholds) instead of hard-coding them in phases — that is what keeps the flow portable and domain-agnostic. |
| `triggers` | Optional. How runs start from the outside world — `cron`, `webhook`, `polling`, `queue`, `events`, `deployment`. The template shows a weekly `cron`. Delete if you only run it manually. See [`../docs/triggers.md`](../docs/triggers.md). |
| `budget` | A spend circuit-breaker over the subtree (`maxCostUsd` and/or `maxTokens`). Crossing it **aborts the run** — it is fatal and never retried. Size it to a real ceiling. |
| `phases` | The serial body: output of phase N feeds phase N+1. Each entry is a node. |

### The phases in the template

- **`prepare-input` — a deterministic `code` phase.** Pure JS, **zero tokens**.
  Do parsing / normalizing / reshaping here instead of spending a model call
  (see AUTHORING_ORCHESTRATIONS.md §5). `code.source` runs sandboxed JS (no
  `fs`, no network) — prefer it. `code.run` (shell out to a real process) is a
  different, **trusted** mode: it is disabled unless `SAMMY_ALLOW_CODE_RUN=1`
  and makes the whole orchestration fully trusted, so reach for an agent with
  the Bash tool (sandbox-governed) before `code.run`.
- **`do-the-work` — an `agent` phase.** The model-in-the-loop kind (the
  expensive one). It is **bounded**: `maxTurns` caps its lifespan, `timeout`
  caps wallclock, `retry` re-attempts transient failures. `prompt` is
  interpolated, so `${prepared}` (the prior phase's output, stored via `as`)
  and `${vars.threshold}` resolve inside it. Store its output with `as` so
  later phases can read it.
- **`process-each` — a fan-out `map`.** Runs the body once per item of
  `${results}`; each item is `${item}` (position `${index}`). `serial:false`
  runs them concurrently — bounded globally by `SAMMY_MAX_CONCURRENT_AGENTS`,
  and per-map by `concurrency`. `continueOnError` on the body collects every
  item's outcome instead of aborting on the first failure.
- **`nested-flow` — a `subflow`.** Composes another saved orchestration by
  name. Only its `phases` run; state is **shared** with the parent, so
  `${processed}` is visible inside, and `as` captures the subflow's final
  output. Compose small, tested orchestrations this way.
- **`final-review` — a `lock` gate.** `lock: true` pauses the run for human
  approval before the phase runs. Put one at any decision that needs a human or
  precedes an irreversible action.

## Knobs the template doesn't show (but you'll often want)

- **`maxAgentTokens`** — a per-phase **safety** ceiling on a single runaway
  agent leaf (distinct from `budget`, which is economic). It is a valid node
  field but is intentionally *omitted* from this template so the JSON stays
  schema-clean and minimal; add it on a known-heavy agent phase
  (`"maxAgentTokens": 50000000`) rather than disabling the breaker. The run-wide
  default and the `SAMMY_MAX_AGENT_TOKENS` env override are explained in
  AUTHORING_ORCHESTRATIONS.md §2.
- **`onError`** — a recovery branch that runs after `retry` is exhausted.
- **`when`** — skip a phase when an interpolated predicate is falsy.
- **`state`** — declared, reducer-folded accumulators for fan-out
  (`append` / `merge` / `replace` / `concat` / `increment`) instead of
  last-write-wins.
- **`sandbox`** — a tool allowlist / Bash denylist / network toggle that
  composes tighten-only down the tree.

Full field reference: [`../docs/schema.md`](../docs/schema.md). Common shapes:
[`../docs/patterns.md`](../docs/patterns.md). How to think about cost, failure,
and concurrency: [`../docs/AUTHORING_ORCHESTRATIONS.md`](../docs/AUTHORING_ORCHESTRATIONS.md).

## Before you commit

Run the pre-commit guardrails (AGENTS.md §5): stage by **explicit path**
(`git add examples/<your-name>.json`, never `git add -A`), scan the staged
content for any domain / secret / PII string (app or company names, keys,
tokens, emails, hostnames, device ids), and confirm there is **none** before
you commit.
