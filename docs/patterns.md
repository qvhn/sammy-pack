# Orchestration patterns

A catalog of common shapes you'll build out of sammy-pack's body kinds
+ decorators. Each pattern is a few lines of JSON; copy and adapt.
The point is to recognize the shape, not to memorize syntax — the
schema (`schema/orchestration.schema.json`) and the dispatch table in
`.claude/skills/sammy-pack/SKILL.md` are the formal references.

## Sequential pipeline

The default. Output of phase N feeds the input of phase N+1.

```json
{ "name": "pipeline", "phases": [
  { "name": "spec",   "agent": "agents/pm.md" },
  { "name": "design", "agent": "agents/uxui.md" },
  { "name": "build",  "agent": "agents/dev.md" }
]}
```

When to use: linear workflows where each phase strictly depends on the
previous one's output.

## U-shape: architect → parallel engineers → reviewer

One designer plans the work, parallel engineers each take a track,
one reviewer reads the merged result.

```json
{ "name": "u-shape", "phases": [
  { "name": "architect", "agent": "agents/pm.md", "as": "plan" },
  { "name": "engineers", "parallel": [
    { "name": "track-a", "agent": "agents/dev.md", "prompt": "${plan}\n\nImplement A." },
    { "name": "track-b", "agent": "agents/dev.md", "prompt": "${plan}\n\nImplement B." }
  ]},
  { "name": "reviewer", "agent": "agents/critique.md",
    "prompt": "Plan:\n${plan}\n\nMerged work:\n${input}\n\nReview." }
]}
```

When to use: a problem decomposes into independent parts that share a
single design. See `examples/architect-engineers-reviewer.json`.

## Fan-out + synthesize (converge)

Several agents see the SAME input from different angles; a merger
synthesizes their replies into one output.

```json
{ "name": "review", "converge": [
  { "name": "product",     "agent": "agents/pm.md" },
  { "name": "engineering", "agent": "agents/dev-lead.md" },
  { "name": "ux",          "agent": "agents/uxui.md" }
], "merger": "agents/summarizer.md" }
```

Each branch runs against an isolated copy of state; writes merge back
in branch-INDEX order at the join, so resume / replay is deterministic.
See `examples/cross-functional-review.json`.

## Refinement loop

Iterate on an output until a stop signal fires. Three stop modes
compose: a substring (`until`), a continue-while substring
(`whileOutput`), and a `judge` agent emitting `STOP` / `CONTINUE`.
With `stopAtScore`, the judge emits a numeric score instead and the
loop exits as soon as `score >= stopAtScore` (a literal STOP still
forces exit).

```json
{ "name": "refine", "loop": {
  "body":  { "name": "rewrite", "agent": "agents/writer.md" },
  "judge": "agents/judge-completeness.md",
  "stopAtScore": 0.9,
  "maxIterations": 5
}}
```

When to use: refinement where "good enough" is meaningful and you
want the loop to stop early. See
`examples/iterative-refinement-scored.json`.

## Route: pick one of N branches

A router agent (or a substring match) decides which branch handles
the input.

```json
{ "name": "triage", "route": {
  "router": "agents/router.md",
  "branches": {
    "bug":     { "name": "bug-flow",     "agent": "agents/dev.md" },
    "feature": { "name": "feature-flow", "agent": "agents/pm.md" },
    "support": { "name": "support-flow", "agent": "agents/writer.md" }
  },
  "default":   { "name": "fallback",     "agent": "agents/summarizer.md" }
}}
```

When to use: incoming work types differ enough that one pipeline
doesn't fit all. See `examples/ticket-triage.json`,
`examples/decision-tree.json`.

## Map: fan-out over a list

Run the same body once per item in an array (parallel by default;
`serial: true` to opt out). `${item}` and `${index}` are bound inside
the body. Parallel iterations get isolated state and merge writes
back in index order.

```json
{ "name": "fan-out", "map": {
  "over": "[\"alice\",\"bob\",\"carol\"]",
  "body": {
    "name": "per-name", "agent": "agents/writer.md",
    "prompt": "Write a one-line greeting for ${item}." }
}}
```

When to use: same operation, varying data. See
`examples/persona-fan-out.json` for the persona variant —
same critic agent, different audience lens.

## Conversation: alternating-turn dialogue

Participants cycle, each seeing the full transcript so far.

```json
{ "name": "debate", "conversation": {
  "participants": ["agents/pm.md", "agents/dev-lead.md"],
  "rounds": 4
}}
```

When to use: multi-agent reasoning where each agent reacts to the
other's most recent reply. See `examples/multi-agent-dialog.json`.

## Compose via subflow

Inline another saved orchestration as a node. State is shared with
the parent — `${as}`-bound outputs propagate both directions. Cycles
are detected.

```json
{ "name": "phase-x", "subflow": "decision-tree" }
```

When to use: building bigger workflows out of named, tested smaller
ones. See `examples/compose-pipeline.json`.

## Federated dispatch (A2A)

Hand a phase off to a remote agent that speaks the A2A protocol.
Honors `timeout` / `retry` / `onError` like any other leaf, and is
skip-replayed on resume.

```json
{ "name": "delegate", "a2a": {
  "agentCard": "https://partner.example.com/.well-known/agent-card.json",
  "skill": "research"
}}
```

When to use: another team / vendor owns the expertise; you don't
want their agent in your repo. See `examples/federated-research.json`.

## Event intake → triage → fix behind human gates

An external system raises events you do not control the volume or content
of — error groups, alerts, support escalations — and each one that matters
should become triaged, deduplicated work, and sometimes a proposed fix a
person approves. The intake controls compose into that shape:

```jsonc
{
  "name": "error-intake",
  "triggers": [{
    "kind": "queue",
    "queue": "error-groups",
    "signed": true,
    "idempotencyTtlSeconds": 86400,
    "scrub": { "allowFields": ["fingerprint", "title", "route", "release", "stats", "samples.*.stack"] }
  }],
  "concurrency": { "group": "fp:${input.fingerprint}", "policy": "skip" },
  "limits": { "maxRunsPerDay": 5, "maxCostUsdPerDay": 20 },
  "notify": { "onGate": "https://hooks.chat.example/T000/B000/XXXX" },
  "worktrees": [{ "name": "app", "repo": "../service", "branch": "fix/${input.fingerprint}" }],
  "phases": [
    { "name": "triage", "agent": "judge-triage", "as": "verdict" },
    { "name": "reproduce",
      "code": { "run": "npx jest --ci ${verdict.testPath}", "artifact": "repro-log" },
      "continueOnError": true },
    { "name": "plan", "agent": "dev-lead", "lock": true },
    { "name": "fix", "agent": "dev" },
    { "name": "verify", "code": { "run": "npx jest --ci", "artifact": "verify-log" } },
    { "name": "ship", "agent": "critic", "lock": true },
    { "name": "record",
      "http": {
        "url": "https://errors.internal.example/groups/${input.fingerprint}",
        "method": "PATCH",
        "headers": { "authorization": "Bearer ${connections:errors-db.value}" },
        "body": { "status": "fixing" },
        "allowHosts": ["errors.internal.example"]
      } }
  ]
}
```

- **Payload hygiene before anything runs** — `scrub` keeps only the fields
  the run needs, so personal data in the event never reaches a prompt.
- **One run per key, once per window** — the templated group allows one
  active run per fingerprint; the 24 h idempotency window lets the same group
  be re-raised tomorrow.
- **Bounded spend** — `limits` holds fires past the daily caps instead of
  dropping them; `POST /api/orchestrations/error-intake/pause` is the kill
  switch.
- **Isolated changes** — the fix happens in a per-run worktree on its own
  branch; with one worktree declared, agents and commands run inside it.
- **Evidence, not claims** — the reproduction and verification logs are run
  artifacts (`GET /api/runs/{id}/artifacts?name=repro-log`).
- **People approve** — `notify.onGate` pings a reviewer the moment the plan
  and the final change reach their gates.
- **Deterministic write-back** — `http` records the outcome without an agent.

Counting and grouping the raw events (which needs to run continuously) stays
outside sammy-pack — a small collector that enqueues one message per group
that crosses a "this matters" threshold. Set `SAMMY_CODE_RUN_ALLOW` to the
test commands (`npx jest *`) rather than enabling `code.run` wholesale.

## Decorator combinators

These compose with any body kind:

- **`onError`** — recovery branch when retries are exhausted; sees
  `${error.message}`. Pairs with `a2a` for fallback to a local agent
  when a remote is down.
- **`retry: { times, backoff: "exponential" }`** — transient API
  errors. Composes with `timeout` (each attempt gets its own bound).
- **`continueOnError`** — failures inside this phase emit a phase-error
  event but the enclosing sequence keeps going. For "log it and
  move on" QA passes.
- **`when`** — predicate skip. Combine with `as` from a router-agent
  earlier in the pipeline to skip whole branches by name.
- **`budget: { maxCostUsd }`** — per-subtree spend circuit breaker.
  Composes with the server-side daily / monthly cap.
- **`lock: true`** — human-approval gate. On server-owned runs this
  pauses the run; `Resume` (or A2A `message/send` with a `taskId`)
  unblocks it.
