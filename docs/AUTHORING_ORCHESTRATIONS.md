# Authoring orchestrations — a practical guide

A field guide for building reliable orchestrations on sammy-pack. The
reference docs ([`patterns.md`](patterns.md), [`schema.md`](schema.md),
[`architecture.md`](architecture.md)) tell you *what the knobs are*. This one
tells you *how to think* — the cost model, the failure semantics, the
gotchas, and the things to settle before you add a node.

It is opinionated on purpose. Most of these lessons were paid for in
runaway token bills, cascading failures, and runs that looked hung but
weren't. Read sections 2 (token economy) and 3 (failure semantics) at
minimum.

> Scope: this is framework-level guidance. Everything here applies to any
> orchestration regardless of what your agents actually *do*.

---

> ## ⚠️ Before you author — and before you commit
>
> **The golden rule:** `sammy-pack` is a **generalized, open framework**. No
> domain-, app-, or company-specific content may land in a committed
> artifact — that means orchestrations, agents, examples, *and* fixtures.
> Keep everything domain-agnostic; push anything machine- or
> environment-specific into `vars` / run `inputs`, never hard-coded.
>
> - [ ] **Domain-agnostic name, prompts, and logic.** The orchestration reads
>   as a reusable shape, not a description of one app's flow.
> - [ ] **No app-specific domains, screen names, personas, credentials, or
>   device IDs** anywhere in the JSON — use generic placeholders and `${vars}`
>   (e.g. `${hostSim}`, "the main screen", `myapp`), never real values.
> - [ ] **Copying an agent file? Source it from `git show HEAD:agents/<name>`,
>   never the working tree.** A working-tree `agents/*.md` may be a *symlink*
>   into a domain workspace; copying it leaks domain content into a committed
>   artifact (the symlink trap).
> - [ ] **Stage by explicit path** — `git add examples/<name>.json`, **never
>   `git add -A`**. `agents/` and `examples/` are allowlists that deliberately
>   exclude imported domain sets; to ship a new generic file, add it *and* its
>   `!name` allowlist entry.
> - [ ] **Test it locally first** (CLI or web UI) and validate against
>   `schema/orchestration.schema.json` before you commit.
> - [ ] **Before committing, scan the staged content** for any secret / PII /
>   domain string (app or company names, keys, tokens, emails, hostnames,
>   device IDs) — there must be **none**.
>
> Full rules: [`../AGENTS.md`](../AGENTS.md) §1–2 (keep it generalized; the
> allowlists) and §5 (the pre-commit scan).

---

## 1. Mental model

An orchestration is a **tree of nodes**, serialized as one JSON object, walked
recursively by the executor (`app/src/llm/executor.ts`).

- **Leaf nodes do work.** Three kinds:
  - `agent` — one model-in-the-loop call (the expensive kind).
  - `a2a` — hand the phase to a remote agent over the A2A protocol.
  - `code` — a pure, deterministic JS transform (no LLM, cost 0).
- **Composite nodes orchestrate** other nodes. They never do work themselves —
  they sequence, fan out, branch, or loop over children:

  | Composite | Shape |
  | --- | --- |
  | `phases` | serial — output of N feeds N+1 |
  | `agents` | serial chain of agents inside one phase |
  | `parallel` | all branches at once; outputs joined |
  | `converge` | `parallel` + an optional `merger` agent over the outputs |
  | `map` | fan-out the same body once per array item (`${item}`, `${index}`) |
  | `loop` | refinement; re-run a body until a stop condition |
  | `route` | pick ONE branch via a router agent or substring match |
  | `switch` | pick ONE case by exact value match (deterministic if/else) |
  | `conversation` | alternating-turn dialogue over a shared transcript |
  | `subflow` | inline another saved orchestration by name (cycle-safe) |

### How state flows

The executor threads a single string — `lastOutput` — from each node to the
next. On top of that:

- **`as: "name"`** stores a node's output in run state. Any later node reads it
  via **`${name}`** in any interpolated field (`prompt`, an agent's system
  prompt, `route.on`, a `code` command, an `a2a` card URL, etc.).
- **`${input}`** is the raw upstream output; **`${item}` / `${index}`** are the
  current `map` element; **`${error.message}`** is available inside an `onError`
  subtree; **`${vars.x}`** are top-level constants.
- **`prompt`** overrides what an agent receives (interpolated) instead of the
  upstream output — use it to give a shared agent a specific instruction
  (e.g. `"Process the ${item} variant"`).
- **Declared `state` slots** (top-level `state: { key: { reducer } }`) fold
  writes through a reducer (`append` / `merge` / `replace` / `concat` /
  `increment`) instead of last-write-wins. This is how a fan-out accumulates
  into one list: each branch appends to the same declared slot and the engine
  merges the deltas in index order at the join.

Two facts that bite people:

- **Interpolation parses dotted paths against a real object.** `${results.2.field}`
  only resolves if `results` is a structured value in state. A `map`'s `as`
  stores a *true array* (so dotted access works); but a plain agent output is a
  *string*, so dotted access into it is empty. If you need structure, emit JSON
  and let a declared reducer or a `code` node parse it.
- **`subflow` runs the referenced orchestration's `phases` (or its single root
  body) — not its decorators.** State is shared with the parent; vars are
  seeded as defaults (parent wins). Compose tested small orchestrations; don't
  expect a subflow's own top-level `budget`/`triggers` to apply.

---

## 2. Token economy & complexity — *the big one*

This is the section that saves money. Read it twice.

### The cost model: one leaf agent is roughly O(N²) in tokens

An agent leaf is a loop of *turns*. **Every turn re-sends the agent's full,
accumulated context** (the SDK has no server-side session here — see the
exchange-loop note in `runAgentPhase`). So if an agent's context grows by a
roughly constant amount each turn — it keeps fetching, observing, and appending
new material it must carry forward — then over N turns it sends
~`1 + 2 + 3 + … + N ≈ N²/2` units of context. **Cost is quadratic in the
agent's lifespan, not linear.**

This is why a single long-lived, context-accumulating agent is the most
dangerous thing you can put in an orchestration. The textbook offender is a
**context-heavy agent that re-sends a growing payload every turn** — it
appends fresh observations each step and re-transmits the whole pile, so the
bill balloons quadratically while the visible progress looks linear.

### The circuit-breaker: `maxAgentTokens`

The executor enforces a **per-agent token ceiling** in
`app/src/server/sdk-stream.ts`. It sums *cumulative* tokens across an agent's
turns (`input + output + cache_read + cache_creation`) and, when a single
agent loop crosses the ceiling, **stops that leaf** by throwing
`AgentTokenCeilingError`.

The design detail that matters: it stops **only that leaf**. It does *not*
abort the shared run-wide signal — that would poison every downstream phase and
make the breaker indistinguishable from a real cancel. Instead it throws out of
the stream loop (which `.return()`s the SDK iterator so the runaway can't keep
burning tokens) and surfaces as an **ordinary per-leaf failure** that flows
through the phase's `retry` / `onError` / `continueOnError` handling.

**Precedence (highest wins):**

| Source | Scope |
| --- | --- |
| node `maxAgentTokens` | this phase only |
| `SAMMY_MAX_AGENT_TOKENS` env | run-wide |
| built-in default (`30_000_000`) | everything |

Set the node field to **`0`** to disable the breaker for a phase (rarely a good
idea). Give a *known-heavy* phase more headroom by raising its node field
rather than the env var, so one greedy phase doesn't relax the safety net for
the whole run.

### Cost (budget) vs. ceiling (safety abort) — they are different

- **`budget: { maxTokens, maxCostUsd }`** is an *economic* circuit breaker over
  a subtree. Crossing it aborts the run (`BudgetExceededError`) — it is fatal
  and never retried. It answers "how much am I willing to *spend*."
- **`maxAgentTokens`** is a *safety* abort against a *single runaway leaf*,
  independent of budget. A leaf can blow its ceiling while the run is well
  under budget (that's the runaway you want caught early), and a run can hit its
  budget across many cheap leaves none of which trip a ceiling. Use both.

### Best practices

- **Bound every agent's lifespan.** Set `maxTurns` on agent phases. The default
  is generous (250) for long iterative work; a sanity-check phase should be
  much lower so it can't loop.
- **Keep per-leaf context small.** Prefer many small, single-purpose leaves
  over one giant agent that accumulates everything. Quadratic growth is per
  agent — three short agents are far cheaper than one long one doing the same
  work.
- **Decompose.** If an agent's job is "do A, then B, then C," that's three
  phases (or a `phases` composite), not one agent. Each starts with a clean,
  small context.
- **Move deterministic work out of the model.** Parsing, filtering, reshaping,
  counting — a `code` node does it at zero token cost. See section 5.
- **Constrain reasoning where you don't need it.** `effort` and
  `maxThinkingTokens` (0 disables thinking) cap the per-call reasoning spend.
- **Defence in depth:** low `maxTurns` + a per-phase `maxAgentTokens` + a
  subtree `budget`. Each catches a different failure shape.

---

## 3. Failure semantics

The core principle: **a leaf's failure should fail *soft* — stopping the leaf —
not poison the whole run.** The framework is built around distinguishing a
*per-leaf error* from a *run-wide cancel*, and your design should respect that
distinction.

### The decorator stack (applied in this order, outermost first)

`when` → `lock` → `budget` → `retry` → `timeout` → `onError` → `as` → `halt`

1. **`when`** — skip the node if the interpolated predicate is falsy
   (`""`/`false`/`0`/`null`/`undefined`); `lastOutput` is preserved. Emits
   `phase-skipped`.
2. **`lock: true`** — human-approval gate before the node runs.
3. **`budget`** — push a spend circuit breaker for the subtree.
4. **`retry: { times, backoff, initialMs }`** — re-attempt the *same* node on
   failure. For transient errors. Each attempt gets its own `timeout`.
5. **`timeout`** (seconds) — per-attempt wallclock cap → `TimeoutError`, which
   then flows through `retry` / `onError` like any other failure.
6. **`onError`** — recovery branch, runs only after retries are exhausted. It
   sees `${error.message}`, and *its* output replaces the failed node's output.
7. **`as`** — store the (post-success or post-recovery) output in state.

### `continueOnError` vs. hard failure

By default a leaf error **bubbles up** and ends the run (after retries/onError).
`continueOnError: true` instead emits a `phase-error` event and lets the
enclosing **sequence** continue — the next sibling in a `phases` composite, the
next iteration in a `map`. Use it for "collect every problem in one pass"
sweeps where you want all the findings, not the first failure.

It composes but is distinct:

- `retry` re-attempts the *same* node.
- `onError` runs a *recovery* branch.
- `continueOnError` *swallows* and moves to the *next* node.

### What always bubbles (never swallowed)

`RunCancelled`, `RunPauseRequested`, and `BudgetExceededError` bubble through
`retry`, `onError`, `continueOnError`, and parallel branches unconditionally.
These are user- or policy-initiated; a misbehaving phase must not be able to
hide them. A budget breach is **fatal by design** — it is the one error you do
*not* want a `continueOnError` to eat.

### Don't let one branch cascade

In `parallel` / `converge` / parallel `map`, each branch runs **protected**: a
branch that throws is *captured*, the siblings finish, and the composite throws
*after* the join with a summary of all failures. So a parallel fan-out collects
every branch's outcome rather than aborting the whole fan-out on the first
failure. Two design implications:

- A parallel composite still **fails as a whole** if any branch failed (unless
  the branch body carries `continueOnError`). If you want partial success,
  put `continueOnError` on the branch body.
- Each branch gets an **isolated copy of state** — concurrent `as:` writes can't
  race. Writes merge back deterministically in branch-*index* order at the join.

### The lesson: shared-cancel vs. per-leaf-error

The single most important failure-semantics rule in this codebase: **do not
turn a per-leaf problem into a run-wide cancel.** The token-ceiling breaker
exists precisely because an earlier version `abort()`ed the *shared* controller
on a runaway leaf, which then failed every downstream phase — even ones marked
`continueOnError` — and was indistinguishable from a user pressing Cancel. If
you extend the engine, throw a *typed per-leaf error* and let the executor
route it; reserve the shared abort signal for genuine run cancellation.

---

## 4. Concurrency, parallelism & memory

Fan-out is cheap to *write* and expensive to *run*. Plan for the machine.

### What actually consumes the machine

Each in-flight agent leaf is a real **agent-SDK subprocess** — real RAM, a real
process, a real model connection. `parallel` runs every branch at once; `map`
fans over an array; and N concurrent runs × M parallel leaves each =
**N·M subprocesses**. A cap on *runs* doesn't bound that.

### The global semaphore

So sammy-pack bounds the real resource at the leaf-dispatch chokepoint
(`app/src/llm/concurrency.ts`). Every leaf dispatch acquires a slot from a
**process-wide semaphore**, holds it for exactly one SDK call, and releases it
in a `finally`. Composites never hold a slot (which is what makes deeply nested
`parallel`-in-`map`-in-`subflow` deadlock-free). Excess dispatches **queue
FIFO** and a waiting phase logs that it's waiting for a slot.

- Default limit is **CPU-derived and conservative**: `max(2, min(6, cores − 2))`
  — leaving headroom for the OS and the host process.
- Override with **`SAMMY_MAX_CONCURRENT_AGENTS`**. The pool can also be resized
  at runtime (growing wakes waiters; shrinking drains as calls finish — it never
  interrupts a running agent).

### Best practices

- **Scale fan-out to the machine, not to the data.** A 50-wide `map` doesn't run
  50 agents at once — it runs `SAMMY_MAX_CONCURRENT_AGENTS` at a time and queues
  the rest. That's a feature; size the env var to your hardware, don't assume
  unlimited parallelism.
- **Bound fan-out at the source too.** `map.concurrency` caps how many items run
  at once *within* a single map (e.g. to match a pool of N external resources),
  in *addition* to the global semaphore. Use it when each item needs a scarce
  shared resource.
- **An LLM-determined `map.over` is an unbounded blast radius.** If the array
  comes from an upstream agent, the engine enforces `sandbox.maxFanout`
  (default 1000) and fails the phase over the cap. Keep it; raise it
  deliberately.
- **Wide fan-out is RAM.** If you see the host thrash, lower the concurrency cap
  before you blame the orchestration.

---

## 5. Determinism vs. model-in-the-loop

Every model call is money, latency, and a source of non-determinism. Spend it
only where the work is genuinely ambiguous.

- **Prefer deterministic phases.** A `code` node (pure JS transform, cost 0,
  bounded CPU/output) handles parsing, filtering, reshaping, math, and exact
  branching. A `switch` does deterministic value-based routing. A `when`
  predicate does deterministic skipping. None of these consume tokens or vary
  run to run.
- **Reserve agents for genuine ambiguity** — judgment, synthesis, open-ended
  generation, classifying free text (`route` with a router agent). If a step's
  output is a function of its input, it doesn't need a model.
- **Grow a "deterministic floor" over time.** A useful long-term posture:
  whenever a model phase's job becomes well-understood and repeatable, replace
  it with a deterministic phase (or pin its behavior with a `code` check). Each
  conversion shrinks model usage, cost, and variance — the floor of guaranteed-
  correct, free, deterministic work rises while the model handles only the
  shrinking ambiguous remainder.
- **Make a model verdict deterministic to consume.** Have a router/judge emit a
  small JSON verdict and feed a `switch` or a declared-state reducer — so the
  *decision* is the model's but the *dispatch* is exact and replayable.

---

## 6. Observability & debugging

Every run is an **append-only event stream** — and everything the UI shows is
derived from it. Debug from the stream, not from guesses.

### The events you'll lean on

- Lifecycle: `run-start` / `run-end` / `run-error` / `run-cancelled` /
  `run-halted` / `run-paused` / `run-interrupted`.
- Structure: `composite-start` / `composite-end` (with the composite `kind`),
  `phase-start` / `phase-end` (with tokens, `costUsd`, `durationMs`, `model`,
  and the `replayKey`).
- Work: `phase-delta` (streamed text), `phase-tool-use` / `phase-tool-result`.
- Control flow: `route-decision`, `loop-iteration` / `loop-stopped`,
  `map-iteration`, `node-retried`, `node-recovered`, `phase-skipped`.
- State & guards: `state-set`, `state-conflict` (two writers, one undeclared
  key), `budget-exceeded`, `tools-warning`.

### Principles

- **A self-reporting breaker beats a silent one.** When the engine stops a leaf,
  the error says *why* and *what to do* — e.g. the token ceiling emits the
  spend, the ceiling, the likely cause, and the remedy (lower `maxTurns`, raise
  `maxAgentTokens`). Follow that pattern in your own `code` nodes and hooks:
  fail with a message that names the cause.
- **A FAIL is a hypothesis, not a verdict.** A phase reporting a failure is the
  *start* of an investigation, not the conclusion. Confirm it from the event
  stream / tool results before you "fix" it — re-running a flaky check often
  reveals the failure wasn't real.
- **Debug from evidence, not the first plausible theory.** The classic miss:
  attributing a hang to "memory" or "timeout" when the stream clearly shows a
  token ceiling tripping (or an agent looping). Read the events; the cause is
  usually right there.
- **A phase that emits no events looks hung but may not be.** A long
  non-streaming call (or an agent thinking) produces no `phase-delta` for a
  while. The run-store heartbeat keeps the lease alive through silent phases —
  but *you* can't tell "working" from "stuck" without evidence. Prefer phases
  that emit progress, and don't assume silence means failure.
- **Export when you need depth.** Runs export as OpenTelemetry (one span per
  phase) for any OTel backend; the Observability page tracks success rate, cost
  trend, and latency.

---

## 7. Resumability & state

**Runs *will* be interrupted** — a crash, a deploy, a lease expiry, a Pause.
Design as if every run can stop after any leaf and pick up later.

How the engine supports it (`app/src/server/run-store.ts`,
`architecture.md`):

- **Checkpoints.** Every completed leaf's output is captured under a stable
  **`replayKey`** (the phase name, scoped by loop iteration / map item / subflow
  instance — so a repeated node checkpoints each execution independently). The
  run header tracks `completedLeaves`.
- **Resume.** A resumed run **skip-replays** captured leaves: it returns the
  stored output instead of re-dispatching the SDK call. You don't re-pay for
  work already done; downstream phases see exactly the input they would have.
- **Fork.** You can fork a run from a completed leaf and re-run forward —
  retrying one phase without re-paying for the (possibly expensive) phases
  before it. Invaluable when iterating on a single phase deep in a long run.
- **Orphan recovery.** Runs hold a heartbeat-renewed **lease**; a process that
  loses its lease cannot write (fencing), and an orphaned `running` row whose
  lease expired is auto-marked `interrupted` and resumed from its last
  checkpoint on boot.

### Design implications

- **Make leaves the unit of progress.** Expensive, slow, or side-effecting work
  belongs in its own leaf so a resume doesn't redo it. A monolithic agent that
  does everything is one un-resumable checkpoint.
- **Side effects must survive a replay.** On resume a leaf returns its *stored
  output* without re-running. If a leaf's real value was a side effect (a write,
  a dispatch), make it **idempotent** — see `idempotencyKey` (sent as A2A
  metadata so a receiver returns the existing task for a repeated key) and the
  durable, dedup-by-key trigger ingress. Don't rely on a leaf re-executing.
- **Lock gates are resumable.** A `lock` on a server-owned run snapshots and
  exits cleanly (`paused`); resume auto-approves the gate the human already
  cleared, so it doesn't re-fire forever.

### Durable waits: `wait.seconds` / `wait.until` / `wait.signal`

A `wait` leaf parks the run at **zero cost** — no process, no tokens, no open
connection — until a timer elapses or an external signal arrives. It's the
same pause seam as a lock gate, but the *server* answers it instead of a
human:

```json
{ "name": "cool-down",      "wait": { "seconds": 259200 } }
{ "name": "monday-morning", "wait": { "until": "${vars.launchTs}" } }
{ "name": "await-approval", "wait": { "signal": "ship-it", "timeoutSeconds": 86400 } }
```

- **Timers are absolute and fixed at first crossing.** `seconds: 300` computes
  one deadline and persists it on the `wait-started` event — restarts and
  early resumes never re-arm the clock. An already-past `until` completes
  immediately with `{"waited": false, ...}` so a `when` downstream can tell.
- **The wait sweeper resumes due runs** (at boot + every 30s), so granularity
  is ~30s — fine for the multi-minute/multi-day waits this is for; don't use
  `wait` as a precision sleep.
- **Signals deliver via `POST /api/runs/:id/signal`** with
  `{"signal": "ship-it", "payload": ...}`. The payload string becomes the wait
  phase's output (bind it with `as`). Early deliveries buffer durably, FIFO
  per name, and a delivery to a parked run resumes it immediately.
  `timeoutSeconds` turns "nobody ever signaled" into a normal retryable phase
  error — pair it with `onError` for a no-approval fallback path.
- **In-memory runs (CLI walk, direct `runOrchestration`) can't park durably**:
  timers sleep in-process; a signal wait with nothing buffered fails loudly
  instead of hanging. Long waits belong on the server.

### Definition versioning: `version` + the snapshot pin

Every run pins the FULL orchestration tree it started with
(`orchestrationSnapshot`), and an in-flight / paused run always resumes
against that snapshot — never against a newer save of the definition. The
root-only `version` field (semver, e.g. `"1.4.0"`) is the human-legible
companion: the executor stamps it on the `run-start` event, so "which
definition did run X execute" is answerable without diffing snapshots.

Bump it like an API: **MAJOR** when replaying an old run's checkpoints
against the new tree would be wrong (renamed phases, moved/removed lock
gates — checkpoint `replayKey`s are phase-name-derived), **MINOR** for added
phases/decorators, **PATCH** for prompt tweaks. There is deliberately no
in-place migration of paused runs: cancel-and-restart (or fork) is the
supported path when a definition changes incompatibly under a paused run.

---

## 8. Governance for autonomous agents

The more autonomy an agent has, the more it needs hard boundaries. The engine
gives you the boundaries; you have to *use* them.

- **Give every loop an explicit stop.** A `loop` always has `maxIterations`; add
  a real exit signal (`until` / `whileOutput` / a `judge` / `stopAtScore`) so it
  stops when *done*, not just when it runs out of iterations. An agent left to
  "explore until satisfied" will over-explore — bound its turns (`maxTurns`),
  its spend (`budget`), and its lifetime (loop stop conditions).
- **Isolate blast radius between parallel branches.** Branches get isolated
  state; lean on it. If two branches must not interfere, also keep their *side
  effects* disjoint (distinct working areas / resources). The engine isolates
  the *state*, not the world.
- **Idempotency + clean state between phases.** Don't assume a phase inherits a
  pristine environment. If a phase needs a known starting state, establish it
  (a `code` setup phase) rather than hoping the previous phase left things tidy.
- **A server-owned run is hard to steer mid-flight.** Once a run is executing on
  the server you cannot reach in and redirect it turn-by-turn (you can Pause,
  Cancel, send a chat message, or approve a gate — but not surgically rewrite
  its plan). So **design the control points in up front**: `lock` gates at
  decisions that need a human, `when` predicates for conditional branches, and
  small phases so Pause/Cancel land at a useful boundary. Build the gates; don't
  plan to improvise.
- **Tighten the sandbox toward the leaves.** `sandbox` (tool allowlist, Bash
  denylist, network toggle, permission-mode floor, `maxFanout`) composes
  *tighten-only* down the tree — a child can never widen what an ancestor
  allowed. Set a restrictive root policy and only loosen where a specific phase
  genuinely needs it. Note this is **policy enforcement, not OS isolation** (a
  tool-equipped agent runs in the server process); treat any orchestration you
  run as one you'd run in your own shell.

---

## 9. Environment & external-dependency contracts

If your agents depend on external state or resources, **the single highest-value
phase you can add is a preflight gate that verifies that state is correct before
the real work starts.**

The failure mode without one: agents run against a broken or misconfigured
external dependency, produce a flood of failures that are really *environment*
problems, and you spend hours triaging noise that has nothing to do with the
orchestration. **Garbage environment in, garbage signal out** — at scale.

So:

- **Verify preconditions in a hard gate at the top of the run.** A first phase
  whose only job is to assert the external resource is present, reachable, and in
  the expected state. If it fails, *halt the run* (`halt`, or just let it throw)
  — don't let the rest run against a known-bad environment and drown the real
  signal.
- **Make preconditions explicit, not assumed.** Declare what the run needs
  (`tools` surfaces required connectors at run start; `inputs` declares required
  run inputs; the gate phase checks live state). An unstated dependency is a
  flaky run waiting to happen.
- **Prefer a self-repairing gate where it's safe.** If the gate can *fix* a
  recoverable precondition (reset/seed the resource) rather than only detect it,
  the run becomes robust to a slightly-off starting environment instead of
  brittle to it. Detection is the floor; repair is the ceiling.
- **Distinguish environment failures from real findings** in your reporting, so
  an env problem never masquerades as a defect in the thing under test.

---

## 10. Gotchas checklist

Skim this before you ship.

- **Interpolation & quoting.** `${name}` resolves against run state + scope.
  Dotted paths (`${a.b.0}`) need a *structured* value in state, not a string —
  emit JSON / use a declared reducer if you need structure downstream. Watch
  quoting when interpolating into a command or a JSON-shaped prompt.
- **A `map`'s `as` is a true array; a plain agent output is a string.** Plan
  which one downstream code expects.
- **`subflow` runs only the referenced orchestration's `phases` (or its single
  root body).** Its own top-level decorators don't apply. State is shared; vars
  seed as defaults (parent wins).
- **A no-event phase looks hung.** Long non-streaming/thinking phases emit no
  `phase-delta`. Don't read silence as failure — check the lease/heartbeat and
  the eventual `phase-end`.
- **Band-aid vs. root cause.** When a phase fails, resist patching the symptom
  (bump the timeout, widen the budget) before you've read the events and found
  *why*. The token ceiling, a missing dependency, and a genuine bug all "look
  like" a timeout from a distance.
- **Silent truncation/caps should be loud.** If you cap something
  (`maxOutputBytes`, `maxFanout`, a manual slice), make sure it *logs/throws*
  when it bites. A silently-truncated payload produces a confusing downstream
  failure with no breadcrumb. The engine's caps fail the phase with a message —
  match that.
- **A FAIL is a hypothesis, not a verdict.** Verify a reported failure (re-run,
  inspect tool results) before concluding it's real. Flaky checks lie.
- **Budget errors are fatal and won't be swallowed.** `continueOnError` does
  *not* eat a `BudgetExceededError` (nor a cancel/pause). Size budgets so they
  reflect a real ceiling, not a per-phase nuisance.
- **A declared provider with no credentials fails loud, not silent.** A phase
  routed to a non-default `provider` with no key configured refuses rather than
  silently running on the default — but tool/subagent/MCP features silently
  no-op on text-only providers (a `tools-warning` is emitted; watch for it).
- **`code.run` (arbitrary shell) is disabled by default.** It needs
  `SAMMY_ALLOW_CODE_RUN=1` and makes the whole orchestration fully trusted.
  Prefer an agent with the Bash tool (sandbox-governed) or `code.source`.
- **Two branches writing the same *undeclared* state key race.** You'll get a
  `state-conflict` event and highest-index-branch-wins. If concurrent writes are
  intentional, *declare* the key with a reducer.

---

## 11. Before you add an orchestration — preflight checklist

Settle each of these *before* writing the JSON. They map one-to-one to the
sections above.

- [ ] **Complexity budget.** Is this genuinely a tree of phases, or one agent
  with too big a job? Decompose long agents into small leaves (§2, §5).
- [ ] **Determinism.** Which steps are deterministic and belong in `code` /
  `switch` / `when` instead of a model call? (§5)
- [ ] **Token ceiling sizing.** Any context-accumulating agent? Set `maxTurns`,
  size `maxAgentTokens` for the known-heavy phases, don't disable the breaker
  (§2).
- [ ] **Failure mode per phase.** For each leaf: bubble, `retry`, `onError`, or
  `continueOnError`? Set `timeout` where a hang is possible. Make sure one
  leaf's failure can't cascade (§3).
- [ ] **Concurrency cap.** Will any `parallel`/`map` fan out wide? Size it to the
  machine (`SAMMY_MAX_CONCURRENT_AGENTS`, `map.concurrency`, `maxFanout`) (§4).
- [ ] **External dependencies.** Do agents depend on external state? Add a hard
  preflight gate that verifies (and ideally repairs) it before real work (§9).
- [ ] **Observability.** Do phases emit enough signal to debug from the stream?
  Will failures self-report their cause? (§6)
- [ ] **Resumability.** Are expensive/side-effecting steps isolated into their
  own leaves? Are side effects idempotent so a replay is safe? (§7)
- [ ] **Governance.** Does every loop/agent have an explicit stop? Are the human
  control points (`lock`) and conditional branches (`when`) designed in, not
  improvised? Is the `sandbox` tightened appropriately? (§8)
- [ ] **Cleanup.** Does each phase establish its own clean starting state rather
  than assuming the previous one left things tidy? (§8)

---

## 12. Lessons from running orchestrations that *act*

The sections above are about the engine. These are about orchestrations that
**drive a real target and create real work-items** — the failure modes that
only show up once a flow is producing side effects at scale. Each is a scar.

### Determinism under shared state

- **Sequence dependent loops; don't overlap them.** Two loops (or two `map`
  branches) that read *and write* the same mutable state are a race — even
  though each branch gets an isolated *copy* of declared run state (§3), the
  *world* they touch is shared. If loop B depends on what loop A wrote, run
  them in series (a `phases` chain), not concurrently. Overlapping them makes
  the result depend on interleaving — the definition of non-determinism. Reserve
  parallelism for genuinely independent work.
- **Prefer deterministic drive over a model-in-the-loop where the path is
  known.** If the steps to reach a state are fixed, *script* them (a `code`
  node, a deterministic tool sequence) instead of asking an agent to figure them
  out each run. Deterministic drive is **$0, reproducible, and replayable**;
  a model re-deriving a known path every run is pure cost and variance. Spend
  the model only on the genuinely ambiguous remainder (§5). A useful test: "if I
  already know the exact sequence, why am I paying a model to rediscover it?"
- **Use a runtime-resolved coordinate/handle seam, not a guessed one.** When a
  step must address a target that isn't stably addressable — an element whose
  position shifts, an ID minted at runtime, a record that may or may not exist —
  *resolve* the handle at run time (query for it, look it up, derive it from
  state) rather than hard-coding a guessed coordinate. A resolved seam survives
  layout/version drift; a guessed one is a flake waiting to fire. Pair this with
  the "FAIL is a hypothesis" rule (§6): a "not found" against a guessed handle is
  usually a stale guess, not a real defect.

### Exclusive access & idempotency

- **Give parallel drivers EXCLUSIVE access to a shared mutable resource.** This
  is a real, recurring failure mode: two concurrent branches driving the *same*
  external resource (a session, a device, a logged-in account, a working
  directory, a fixed record) clobber each other — one's action lands in the
  other's context and both produce garbage. The engine isolates *state*, not the
  *world* (§8). Either bound fan-out to a pool of N **distinct** resources
  (`map.concurrency` = N, one resource per item) or serialize access. Never let
  two drivers share one mutable resource at once.
- **Make each run IDEMPOTENT — start from a fresh, known state, and vary keys so
  re-runs don't collide.** A run that creates records must be safe to run twice:
  establish a clean starting state up front (a `code` setup phase — don't inherit
  the last run's leftovers, §8), and namespace any created identifiers with a
  per-run key (a run id, a timestamp, a UUID) so a re-run doesn't collide with or
  overwrite the previous run's artifacts. Combine with `idempotencyKey` on
  side-effecting leaves so a *resume* (which replays a completed leaf from its
  stored output, §7) doesn't double-fire the effect.

### Triage before you create work

- **Gate every work-item behind a REPRODUCE-OR-SKIP triage.** Before a flow
  files a ticket / issue / work-item, make it decide among **three** outcomes,
  not two:
  1. **Reproduced** → proceed *with the reproduction attached* (steps, inputs,
     evidence). A repro is what makes the item actionable.
  2. **Strong signal but not reproduced** → don't file blind; *dig deeper* (retry,
     gather more evidence) or *flag for human review* — explicitly marked as
     unconfirmed.
  3. **Weak / unconfirmed** → **skip it.** Filing noise is worse than filing
     nothing; it erodes trust in the whole pipeline.

  This is the operational form of "a FAIL is a hypothesis, not a verdict" (§6) —
  applied at the moment of *creating durable work*, where the cost of a false
  positive is highest. A `switch` over a small JSON verdict (§5) makes the
  three-way gate deterministic.
- **DEDUP before creating a ticket/work-item.** A flow that re-runs (or fans out)
  will rediscover the same finding repeatedly. Before creating an item, compute a
  stable **fingerprint** of the finding (normalize the signal — strip run-specific
  ids, timestamps, line noise) and **check whether a matching item already
  exists**; if so, link/annotate the existing one instead of opening a duplicate.
  Without this, a recurring or parallel flow buries the real signal under
  duplicates. (Mirror the engine's own durable dedup-by-key ingress, §7.)

### Evidence & the regression ratchet

- **Capture PER-STEP artifacts, not just terminal state.** When a multi-step
  drive fails, the *terminal* state rarely tells you *where* it went wrong. Have
  each step emit an artifact (a snapshot, a log line, the observed result) so a
  failure is debuggable from the trail, not a guess. This is the actionable form
  of "make leaves the unit of progress" (§7) and "debug from evidence" (§6): the
  per-step trail is the evidence, and it's also what a reproduction (above) is
  built from.
- **RATCHET: every confirmed defect becomes a permanent regression check.** When
  a defect is confirmed and fixed, don't just move on — add a deterministic check
  that would have caught it, and keep it forever. Over time the suite of
  guaranteed-correct checks only grows (it *ratchets* — it never loosens), so the
  same defect can never silently return. This is the "deterministic floor rising"
  posture (§5) applied to defects: each confirmed bug converts, permanently, into
  a cheap deterministic guard.

### Headless & scheduled runs

- **Cron / headless runs can't use interactively-authenticated integrations.**
  A flow that runs unattended (a `cron` trigger, a server-owned background run)
  has **nobody to complete an interactive login / OAuth / device-approval flow**.
  Any integration it touches must use a **non-interactive credential** — a
  long-lived token, a service account, a pre-provisioned key (via the credentials
  registry / `credential` field, server-side) — established *before* the run.
  Assuming an interactive session that won't exist at 3 a.m. is a guaranteed
  unattended failure; declare the dependency and verify it in a preflight gate
  (§9).

### Driving real external tools (device / process automation)

When a phase shells a real process that drives the outside world (a device, a
browser, a CLI) — via `code.run` — you leave the tidy world of pure functions,
and a distinct class of gotcha appears. These are paid-for:

- **Isolate the working directory of external-process steps.** A `code.run`
  child inherits the server's cwd by default, so any artifact it writes by a
  *relative* path (a screenshot, a temp file) lands **in the repo**. Give such
  steps their own scratch dir (the executor runs `code.run` children in an
  isolated temp cwd) so a run never pollutes the workspace.
- **Deterministic *drive* is not a deterministic *environment*.** The decision
  path can be fixed while the layer underneath is not — an automation driver may
  reinstall itself between invocations, the accessibility/DOM tree can flatten or
  virtualize away the handle you targeted, the OS can throw a modal mid-flow. A
  robust chain *absorbs* that: re-assert known state **before** each step (and
  again after any slow driver restart), fall back to a **runtime-resolved
  handle** when the declared selector lies, retry across the transient-failure
  window, and re-establish the environment (restart / reboot) when it wedges.
- **"On the chrome" ≠ "at the root".** A check that asks "is the nav bar
  present?" is fooled by a *pushed inner screen* that still shows the bar (it
  carries a back affordance). When run N+1 inherits run N's end-state you can
  start several screens deep — so verify you're at the **root** (no
  back-affordance + the root element present), not merely that the chrome shows;
  then your reset can pop back reliably.
- **Verify from the driver's output, not its side-effect files.** A sandboxed
  verification step (no `fs`) must parse the driver's **stdout / structured
  result**, not read a manifest off disk.
- **"It runs through the framework" must be as reliable as "I run it by hand".**
  A human absorbs all the above implicitly (you just re-tap when something's
  off); the framework earns "run it unattended overnight" only once it absorbs
  it explicitly — isolated cwd, state re-assertion, retry semantics. Prove it
  with an **unattended re-run from inherited (bad) state**, not a clean start —
  that's the test that separates a happy-path demo from a trustable platform.

---

*See also: [`patterns.md`](patterns.md) (shapes), [`schema.md`](schema.md)
(every field), [`architecture.md`](architecture.md) (durability & sandbox),
[`context-engineering.md`](context-engineering.md) (managing agent context),
[`deployment.md`](deployment.md) (env vars, spend caps, scaling).*
