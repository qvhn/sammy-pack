---
name: sammy-pack
description: Execute a sammy-pack orchestration from the CLI. Resolves an orchestration JSON, walks the node tree, dispatches each leaf agent via the Agent tool, runs parallel branches concurrently, honors retries / timeouts / budgets / onError / continueOnError, awaits user approval at locked phases, and supports every body kind (agent, agents, phases, parallel, converge, subflow, loop, conversation, route, switch, map, a2a). Invoke when the user names an orchestration ("run ticket-to-pr", "execute parallel-research-then-build for jira-123") or asks to "run the orchestration for X".
---

# sammy-pack — CLI orchestration runner

This skill executes a sammy-pack orchestration end-to-end via Claude Code's
built-in tools. The orchestration JSON is the same file the web/mobile UI
reads and writes — both surfaces operate on a single source of truth, and the
parity test at `app/__tests__/cli-parity.test.ts` enforces that every schema
field this skill could see is documented here AND implemented in the web
executor.

## Required tools

Make sure these are available (or load them) before running:

- **Read** — to load orchestration JSON and agent markdown files
- **Agent** — to dispatch each leaf phase as a subagent
- **AskUserQuestion** — to gate at `lock: true` phases
- **Bash** — only if an agent needs to write files; not required by the skill itself

## When to invoke

A user types something like:

- `/sammy-pack run ticket-to-pr`
- `/sammy-pack run parallel-research-then-build for JIRA-123`
- "run the ticket-to-pr orchestration for this PR"
- "execute the spec phase of ticket-to-pr"
- "what does parallel-research-then-build do?" → describe + offer to run

If the user just asks *about* an orchestration (no "run" / "execute" verb), describe its structure without dispatching agents.

## Step-by-step

### 1. Locate the orchestration file

Orchestrations resolve relative to the current working directory. Look in
this priority order:

1. `./orchestrations/<name>.json`
2. `./examples/<name>.json`
3. The directory named by `SAMMY_ORCH_DIR`, if set
4. An absolute or cwd-relative path if the user provided one

(These are the same locations the bundled `sammy-pack` MCP server's
`list_orchestrations` / `start_run` tools scan, so the skill and the MCP
server agree on what's runnable.)

Read the file. Validate against `schema/orchestration.schema.json` if it
exists and you want to be strict (skip on simple files).

If the file is not found, list the candidate names you tried and the contents
of `./examples/` and `./orchestrations/`, then stop.

### 2. Resolve the initial input

If the user provided context after the orchestration name (e.g. "run ticket-to-pr **for JIRA-123**"), capture the trailing text as the initial input. Pass it to the first phase. Otherwise the first phase starts with an empty input.

### 3. Seed top-level `vars`

If the orchestration's root node declares `vars: { key: value, ... }`, treat
every entry as a string available for `${name}` interpolation in every
descendant phase's `prompt`, agent input, and other interpolated strings.
This is the orchestration-wide constants table — simulator UDIDs, environment
names, feature flags — so a value change is one edit rather than many.

Example: with `vars: { hostSim: "A1B2C3D4" }`, any descendant prompt
containing `${hostSim}` resolves to `A1B2C3D4` at dispatch time. Vars also
flow into the run's state so `as`-bound outputs and `vars` can be referenced
the same way.

If the root node carries a `lifecycle` block with `deprecated: true`, flag
the run with a one-line warning that names the orchestration and the
`deprecationReason` (if any) — then proceed normally. `lifecycle.stage`
(`dev` / `staging` / `prod`) is informational and does not gate execution.

If the root node carries a `triggers` array (webhook / cron), those are
**server-side** entry points that fire runs without a human in the CLI
loop. From the CLI walk, just note their presence in the report — they
don't affect this run.

If the root node declares `state: { <key>: { reducer: ... } }`, seed
each declared slot with its `initial` (or the reducer's natural
identity: `append` → `[]`, `merge` → `{}`, `increment` → `0`,
`replace`/`concat` → undefined). When a descendant phase writes to a
declared key via `as:`, fold the new value through the reducer
instead of replacing the slot: `append` concatenates arrays, `merge`
object-spreads, `concat` joins strings with newlines, `increment`
adds numerically, `replace` is last-write-wins (same as undeclared).
Parse each agent's output as JSON before folding, falling back to the
raw string if parsing fails. Undeclared keys keep replace-on-write —
purely additive, pre-existing orchestrations don't change.

If the root node declares `inputs: [{ name, kind, required?, ... }]`, the
run takes typed references (a Jira ticket, a PRD/Confluence link, a URL,
an uploaded doc). Before phase 1, collect a value for each (ask the user
via `AskUserQuestion` if not supplied), resolve it to text — `text`
as-is; `url` via **WebFetch**; `jira`/`confluence` via the Atlassian
**MCP** tool (or WebFetch with the configured credential); `github` via
the GitHub API; `file` by reading the file — and seed it into state as
`${name}` so phases interpolate it. Refuse the run if a `required` input
is missing. Orchestrations with no `inputs` take a single free-text
initial input as today.

If a node sets `provider` (`anthropic` / `openai` / `gemini` / `claude-code`)
and / or `model`, route THAT phase to the chosen provider + model. Other
phases use the run-wide default. A node can also set `credential: "name"`
(paired with `provider`) — that names an entry in the workspace's
credentials.json registry whose value becomes the API key for THIS phase
only. Server-owned runs only; from the CLI walk, surface a one-line note
that the phase asked for credential `<name>` and proceed. The CLI itself runs through the Agent
tool which uses the active Claude Code session, so a non-Anthropic
`provider` only matters when running through the web app's executor;
in CLI walks, treat `provider: "anthropic" | "claude-code"` as the
Agent-tool path and surface a one-line warning when a phase asks for
a non-Anthropic provider you can't dispatch.

### 4. Walk the node tree

For each Node in the tree, apply this loop in order:

1. **`when` predicate** — if set, interpolate it against current state. If
   the result is falsy (`""`, `"false"`, `"0"`, `"null"`, `"undefined"`),
   skip this node and leave the last output unchanged.
2. **`lock`** — if `lock: true`, gate via `AskUserQuestion` (see §6).
3. **`prompt` interpolation** — if `prompt` is set, use it as the literal
   user message for the agent, interpolating `${name}` against state +
   scope-local vars (`${item}`, `${index}` inside `map`, `${vars.*}` from
   top-level vars, `${as-bound-name}` from prior phases). When `prompt`
   is set, it REPLACES the upstream output as the agent's input.
4. **Dispatch by body kind** — see the table in §5.
5. **`timeout`** — wrap each attempt in the declared per-attempt wallclock
   budget (seconds). Exceeding it counts as an attempt failure.
6. **`retry`** — on failure, re-attempt up to `retry.times` more times with
   `retry.backoff` (`"fixed"` | `"exponential"`) and `retry.initialMs`.
7. **`onError` / `continueOnError`** — when all attempts fail:
   - If `onError` is set: run that recovery branch with `${error.message}`
     available in scope. Its output replaces the failed node's output.
   - Else if `continueOnError: true`: emit a `phase-error` summary line and
     continue the enclosing sequence / map iteration WITHOUT propagating.
   - Else: surface the error and abort the run (or the closest enclosing
     `parallel`/`converge` branch — see §5 for fan-out semantics).
8. **`budget`** — if the node declares a `budget: { maxTokens, maxCostUsd }`,
   keep a running tally for this subtree. If a tally crosses the threshold
   before or after any inner agent call, abort the run with a clear summary
   of where the budget was exceeded. Budgets nest: an outer budget covers
   inner subtrees too.
8a. **`halt`** — if a node sets `halt: true`, end the run once that node
   completes: the run finishes with this node's output and NO later
   sibling/phase runs. Combined with `when` it's a conditional early return
   ("return when ${...}"): a falsy `when` skips the node (no halt), a truthy
   one runs it then stops. The halt unwinds through every enclosing
   sequential composite (phases / loop / serial map); any `parallel`/`map`
   siblings already in flight finish, and the halt takes effect at the next
   sequential boundary.
9. **`tools`** — declared connector / tool deps. Surface the list to the
   user so missing tools are visible; the parent Agent invocation
   ultimately chooses the toolset for each subagent.
9a. **`mcp`** — names of MCP servers (from `mcp/servers.json`) this leaf
   agent needs, e.g. `["ios-simulator"]` to drive a simulator or
   `["atlassian"]` for Jira. Opt-in per agent: the runner exposes only the
   listed servers' `mcp__<name>__*` tools to that agent. From the CLI walk,
   ensure the named MCP servers are connected and let the subagent use their
   tools; on the web/server-owned path the executor resolves each name to its
   full config (secrets stay server-side) and passes it to the SDK.
9b. **`sandbox`** — execution-safety policy. A node's effective sandbox is
   its own merged with every ancestor's (tighten-only: tool allowlists
   intersect, command denylists union, the stricter permissionMode wins).
   Enforce it: cap an agent's tools to `sandbox.allowedTools`; drop
   WebFetch / WebSearch when `sandbox.networkAccess` is false; abort the
   phase if a Bash command contains any `sandbox.deniedCommands`
   substring; pin the permission mode to the stricter of the node's own
   and the sandbox floor. A blocked tool / command is a phase failure —
   it routes through retry / onError / continueOnError like any other.
10. **`maxTurns`** — pass-through to the Agent dispatch when supported by the
    runner. Default is the proxy's per-call cap; bump for agents driving
    long iterative flows (UI automation, simulator-driving, multi-file
    refactors), lower for sanity-check phases.
11. **`input` / `output` contracts** — when a node declares an `input` or
    `output` as an inline JSON Schema (an object with `type` / `properties`
    / `required` / etc.), enforce it. Before dispatch, check the input the
    phase receives against `input`; after the agent returns, check its
    output against `output`. The agent is expected to emit JSON when an
    `output` schema is present (a ` ```json ` fence is fine — strip it).
    A violation is a real failure: treat it like a phase error so `retry`
    / `onError` / `continueOnError` apply. The web executor enforces this
    with `app/src/lib/json-schema-check.ts`; do the same best-effort check
    here. The STRING form of a contract (a JSON-pointer / file path) is
    documentation only — don't try to resolve it.
12. **Output capture** — if `as` is set, store this node's output in state
    under that name; descendants can read it as `${name}` in interpolated
    strings.

### 5. Body kinds (the dispatch table)

Every Node has exactly one of these body keys — the `oneOf` enforcer in the
schema. The CLI must handle each:

| Body | What to do |
| --- | --- |
| `agent` | Single agent. Dispatch via **Agent** tool (see §7). Output → next phase's input. |
| `agents` | Serial chain of agents inside one phase. Dispatch each in order; pipe output → input. Final agent's output is this phase's output. |
| `phases` | Nested serial phases. Recurse — walk each child phase in order. |
| `parallel` | Independent branches. Dispatch all in a **single message with multiple Agent tool calls** so they run concurrently. Union the outputs (with branch-name headings) as the next input. |
| `converge` | Parallel branches that may conflict. Same as `parallel`, then if `merger` is set, run the merger agent with all branch outputs joined as `"## Branch: <name>\n\n<output>"` blocks separated by `---`. The merger's output is this composite's output. |
| `subflow` | Load the referenced orchestration JSON (resolve relative paths from the orchestration's own directory) and recurse this skill on it. Seed the referenced orchestration's own top-level `vars` (and `state` initials) into scope first so its phases can interpolate `${theirVar}` — a value the parent already set wins. State is shared with the parent, so `${as}` writes inside a subflow are readable downstream. The subflow's final output bubbles up as this node's output. |
| `loop` | Refinement loop. Run `body` up to `loop.maxIterations` times, piping each iteration's output as the next iteration's input. Stop early when: `loop.until` substring matches the body output (case-insensitive), `loop.whileOutput` STOPS matching the body output (loop continues only while present), or `loop.judge` agent returns a JSON verdict `{"decision": "STOP" | "CONTINUE"}` (a bare `STOP`/`CONTINUE` reply still works). When `loop.stopAtScore` is set, the judge is instead asked for `{"score": <number>, "stop": <bool>}` and the loop exits as soon as `score >= stopAtScore`; `stop: true` (or a literal STOP) always overrides. If `loop.retryOnFailure: true`, errors inside the body don't abort — the error message becomes the next iteration's input. By default (`loop.carryContext`, on unless set `false`) each re-iteration's input is framed as a refinement of work that already exists, so the worker builds on prior output instead of cold-starting and re-deriving context; `loop.warmSession: true` carries the full prior-iteration history forward each round (stronger, but context grows). When walking from the CLI, prepend the same refinement framing to the body input on iterations after the first. |
| `conversation` | Cycle through `conversation.participants` (agent paths) for `conversation.rounds` turns. Each turn, the next participant in the cycle sees the full transcript so far and emits their reply. The transcript is the composite's output. |
| `route` | Conditional routing. If `route.router` agent is set, dispatch it to classify the input — ask for a JSON verdict `{"branch": "<one of the branch keys, or default>"}` and take that branch (a bare branch name in the reply still works as a fallback). Otherwise, substring-match the input against `route.branches` keys (case-insensitive). On no match, use `route.default` if set, else error. Recurse into the chosen branch. |
| `switch` | Deterministic value-based branching (a switch/case, and if-else via `true`/`false` cases). Resolve the value to switch on: `switch.on` interpolated over state+scope (e.g. `${verdict}`) if set, else the upstream phase output. Match that value EXACTLY against `switch.cases` keys — normalized (trim, strip wrapping quotes, case-insensitive), with a structured `{"case":"<key>"}` verdict or a value printed on the last line also honored. Crucially this is NOT substring matching (unlike `route`): a discrete value like `false` must not hit a `true` case. On a match, recurse into that case with the original input; on no match, use `switch.default` if set, else error. Use this when a preceding script/agent returns a discrete value (true/false, x/y/z, a status) and cases should fire off it. |
| `map` | Fan-out over an array. Resolve `map.over` to an array (either `${state-var-name}` or an inline JSON literal like `["a","b","c"]`). For each item, run `map.body` with `${item}` and `${index}` available in interpolation. If `map.serial: true`, run iterations one at a time; otherwise issue them in a single message with N Agent calls. Iteration outputs are joined as the map's output, and (if `as` is set) stored as a true array in state. |
| `a2a` | Outbound call to a remote agent over the A2A (Agent2Agent) protocol. `a2a.agentCard` is the URL of the remote agent's card. Fetch the card (a JSON document) with **WebFetch** to get its JSON-RPC `url`, then POST a JSON-RPC `message/send` request with the upstream phase output as a `TextPart`, poll `tasks/get` until the task reaches a terminal state, and use the result artifact's text as this phase's output. `a2a.skill` (optional) names which remote skill to invoke. If the node sets `idempotencyKey`, interpolate it and include it as `params.metadata.idempotencyKey` on the `message/send` — a sammy-pack receiver returns the existing task for a repeated key instead of starting a duplicate run, so re-dispatching after a crash is safe. A `failed` / `canceled` / `input-required` task is a phase error — route it through `retry` / `onError` like any other failure. |
| `code` | Inline JavaScript transform — **no LLM call**. `code.source` is a snippet that runs as an async function body with `input` (string), `state` (run state object), `item` + `index` (inside `map`), and `vars` (top-level vars) in scope. The snippet's `return` value becomes the next phase's input (non-string returns are JSON-stringified). For deterministic reshaping between agents — parse JSON, filter arrays, slice strings — without burning tokens. Trust model is the same as a Bash-tool agent: the snippet has full host access; gate at the run boundary, not the snippet. From the CLI, you can dispatch the snippet via the **Bash** tool (`node -e "..."`) or just evaluate it in-process; do NOT call an LLM for `code` phases. Alternatively, `code.run` (mutually exclusive with `source`) is an external script path / shell command — pipe the upstream output to its stdin, use its stdout as the phase output, and treat a non-zero exit as a phase error (`scripts/x.sh`, `python score.py`, `node tool.js`); from the CLI, run it via the **Bash** tool with the upstream output on stdin. |

A note on `converge`: branch state is merged back **single-writer** — each branch runs against its own copy of run state, and after the join the branches' `as:` writes are folded into the parent in branch-index order (not completion order). If two branches write the same `${name}`, the later branch by index wins, deterministically. Run branches one at a time in index order to match.

### 6. Locked phases (`lock: true`)

When a node has `lock: true`:

1. Show the user a structured summary of what's about to happen: phase name,
   the agent / composite about to run, and a preview of the input that will
   be passed in (~200 chars truncated).
2. Use **AskUserQuestion** with two options: "Continue" and "Cancel".
3. On Continue: proceed.
4. On Cancel: stop the run; emit a final summary of what completed.

Locks are about **human approval**, not branching. The user should always be
able to halt before sensitive work (e.g. before code is written or a record is
created on a simulator).

### 7. Dispatch a single agent

To run one agent at a leaf:

1. Read the agent file at the path in `agent` (e.g. `agents/pm.md`). It is
   markdown with a frontmatter block.
2. Split frontmatter from body. The body is the agent's system prompt.
3. Build the dispatch input:
   - If `prompt` is set on the node: use that (interpolated) as the user
     message — it overrides any upstream output.
   - Otherwise: use the previous phase's output.
4. Call the **Agent** tool with:
   - `subagent_type`: `general-purpose` (or a more specific type if one
     matches; sammy-pack agents are generic).
   - `description`: a short label like `"<phase-name>: <first-line-of-body>"`.
   - `prompt`: a self-contained brief built from the agent's body + the
     dispatch input from step 3. Format roughly:

     ```
     [Agent role / body from agents/<name>.md]

     ---
     Inputs for this phase:
     <dispatch input, or "(no prior output — this is the first phase)">

     Produce the output described above. Return only the final artifact.
     ```

5. The subagent's returned message is the phase output.

If the agent's frontmatter declares its own `tools` allowlist, mention it but
don't try to enforce inside the subagent — the parent Agent invocation chose
the toolset.

### 8. Composites — execution detail

The §5 table is authoritative, but a few composites have nuance worth
calling out:

- **`phases`** — recurse: apply this whole skill to the inner `phases: [...]`
  as if it were a sub-orchestration. The final output bubbles up.
- **`parallel`** — ONE message with multiple Agent tool calls. Branches must
  be truly independent; do not share mutable resources between them. If one
  branch errors and has no `onError`/`continueOnError`, the whole composite
  fails (treat sibling branches' results as cancelled).
- **`converge`** — fan-out like parallel, then synthesize. The `merger`
  agent gets one consolidated input where each branch's contribution is
  labeled and separated by `---`. If `merger` is unset, surface a warning
  that conflicts (if any) weren't resolved, and concatenate raw outputs.
- **`loop`** — apply stop conditions BEFORE the next iteration starts, in
  this order: `loop.until` match → exit; `loop.whileOutput` no-match →
  exit; `loop.judge` says STOP → exit; `loop.maxIterations` reached → exit.
- **`map`** — when `serial: true`, treat as an in-order for-loop where each
  iteration sees the FULL prior context (handy for shared-simulator QA
  suites). When `serial` is omitted or false, dispatch all iterations
  concurrently and union outputs.

### 9. Report progress

As you execute, tell the user what's happening — they should never wonder
what's running. After each phase, summarize:

- ✓ `<phase-name>` complete (or ✗ on error, ⊘ on skipped via `when` /
  cancelled lock, ↻ on retry)
- 1-2 sentence summary of what that phase produced

For `continueOnError` phases: when a failure occurs, emit a clear
`phase-error: <phase-name> — <message>` line and continue, so the user can
see the defect log without losing the rest of the run.

Don't dump full agent outputs into the conversation; the user can read the
artifact in the file system or scroll back through the subagent results.

### 10. Final report

When the run finishes, give a single-paragraph wrap-up: what completed,
what was skipped / cancelled / errored-but-continued, and where the
artifacts live (if the agents wrote files). For runs with multiple
`continueOnError` failures, list each defect once at the end.

## Shared state with the UI

The same JSON files this skill reads are also read AND written by the
sammy-pack web UI. If a teammate edits an orchestration in the UI, this skill
picks up the changes on the next invocation. There is no sync step.

### Two ways to run, and when to use each

1. **In-session walk (this skill).** Dispatch each leaf phase via the Agent
   tool in the current Claude Code session. No API key, no server — but the
   run is NOT recorded in the web dashboard. Best for ad-hoc / interactive
   runs you're driving by hand.

2. **Server-owned run (the bundled MCP server).** This plugin ships an MCP
   server named `sammy-pack` exposing `list_orchestrations`, `start_run`,
   `get_run`, `cancel_run`, and `resume_run`. `start_run` launches the run on
   the embedded engine against the SAME run store the web UI reads (a local
   `runs.db`, or Postgres if `DATABASE_URL` is set), so the run shows up live
   in the dashboard's **Runs** page and survives the session ending. Best when
   the user wants the run tracked, resumable, or running unattended.

   Prefer the MCP `start_run` tool when the user says "track this in the
   dashboard", "start a run I can watch", or wants it to keep going after the
   session. Use `get_run` to poll status (per-phase state + token/cost rollup)
   and `cancel_run` / `resume_run` to control it. The MCP server resolves
   orchestrations from the same locations as §1 (`SAMMY_ORCH_DIR`, else
   `./orchestrations`, else `./examples`).

## Staying in sync with the engine

This skill and the engine's executor MUST agree on every schema-declared node
property and body kind — the in-session walk (§4/§5) and a server-owned run
(MCP `start_run`) should produce the same behavior for the same orchestration
JSON. If you add a new property to the orchestration schema, document it here
AND make sure the executor implements it.

## What this skill does NOT do

- It does not call the Anthropic API directly. It uses the Agent tool, which
  is the user's existing Claude Code session.
- It does not need an API key.
- It does not handle long-running async background work — each Agent
  invocation is synchronous from this skill's POV.
- It does not yet handle: dataset-driven runs, eval scoring. Those are
  deferred to the web/mobile execution path.
