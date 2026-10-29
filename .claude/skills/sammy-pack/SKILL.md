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

Look in this priority order:

1. `orchestrations/<name>.json`
2. `examples/<name>.json`
3. Absolute or repo-relative path if the user provided one

Read the file. Validate against `schema/orchestration.schema.json` if you want to be strict (skip on simple files).

If the file is not found, list the candidate names you tried and the contents of `examples/` and `orchestrations/`, then stop.

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

If the root node declares a `defaults` block, treat each entry as the
run-wide fallback for the matching per-node resource limit — a node that
omits its own `timeout` / `stallTimeout` / `maxAgentTokens` inherits the
value from `defaults` before falling back to the env / built-in default.
Resolution is strictly `node.X ?? defaults.X ?? <env / built-in default>`:
a per-node value always wins, and an omitted `defaults` block changes
nothing. `defaults` is read only off the orchestration root — a `defaults`
block on a child node is ignored. Use it so an orchestration whose phases
all want (say) a longer stall window declares it once instead of repeating
it on every phase. Example: `defaults: { stallTimeout: 900 }` gives every
phase that doesn't set its own a 15-minute no-progress window.

If the root node sets `autoApproveLocks: true`, every `lock: true` human gate
auto-approves WITHOUT pausing — for UNATTENDED runs (cron / webhook) where no
human is present to approve. The gate still emits its `lock-gate` event (the
audit trail is preserved) and a warning is logged naming the gated phase, but
the run proceeds as approved instead of blocking on approval. Defaults to
`false` (every lock pauses for human approval). Read only off the orchestration
root — a value on a child node is ignored.

If the root node sets `execution: "harness"`, YOU are the harness: do NOT
dispatch an Agent-tool subagent per agent step. Work through the steps
yourself, one at a time, in the order the tree lists them (a `phases` section
flattens into its steps; a `parallel` of single steps may go in any order among
themselves; any other composite — `loop`, `map`, `route`, … — runs as this skill
describes below, as one step). For each step: read its agent file as the
guidelines and its `prompt` as the task, and do it; a step with `skill: "<name>"`
is done by running that skill with the Skill tool; `code` / `http` / `wait`
steps run exactly as written. How strictly to keep the order is the root's
`harness.follow`: `strict` (default) — in order, a step starts only when the one
before it is done; `loose` — any order, every required step done before you
finish; `advisory` — you may skip a step, saying why, and the final report
lists it as skipped. Gates (`lock`), budgets and the sandbox hold in every mode.
`harness.instructions` is extra guidance for you; `harness.model`,
`harness.maxTurns` and `harness.lockFollow` only matter to a server run. A
pipeline run (`execution` absent or `"pipeline"`) ignores `skill`.

If the root node carries a `concurrency` block (`{ group, policy? }`), it
declares mutual exclusion for runs that share an external resource: runs whose
root names the same `concurrency.group` are never allowed to overlap. The group
is an OPAQUE string — neither you nor the framework interpret what it stands for
(a staging environment, a device, a rate-limited account). `concurrency.policy`
(`skip` / `queue` / `cancel-existing`, default `queue`) decides what a fire does
when the group already has an active run. This is enforced **server-side** at the
run start-gate, not in the CLI walk — from the CLI just note its presence in the
report; it does not change the run you are driving. Read only off the
orchestration root.

If the root node carries a `lifecycle` block with `deprecated: true`, flag
the run with a one-line warning that names the orchestration and the
`deprecationReason` (if any) — then proceed normally. `lifecycle.stage`
(`dev` / `staging` / `prod`) is informational and does not gate execution.

If the root node carries a `triggers` array (webhook / cron), those are
**server-side** entry points that fire runs without a human in the CLI
loop. From the CLI walk, just note their presence in the report — they
don't affect this run. The same goes for a trigger's ingress options —
`scrub` (PII redaction applied to the payload before it is stored) and
`idempotencyTtlSeconds` (how long a repeated `Idempotency-Key` is
suppressed): they shape how the SERVER records an inbound fire. If the user
hands you a raw payload for a CLI walk of an orchestration whose trigger
declares `scrub`, say that the payload has NOT been scrubbed.

If the root node carries `limits` (`maxRunsPerDay`, `maxCostUsdPerDay`,
`maxCostUsdPerMonth`), those cap TRIGGER-fired runs at the server's
admission check (a fire over a limit is held until the window rolls over);
manual starts — including a CLI walk — are not counted. Note them in the
report; they don't stop the run you are driving.

If the root node declares `worktrees` (`[{ name, repo, base?, branch?,
cleanup? }]`), the run must work in an ISOLATED git worktree per entry,
never in the repository's own checkout. Before phase 1, for each entry run
(via **Bash**) `git -C <repo> worktree add -b <branch> <path> <base>` —
`<repo>` resolved against the workspace root, `<branch>` from the `branch`
template (`${run.id}`, `${run.short}`, `${orchestration}`, `${worktree.name}`,
`${input.<field>}`; default `sammy/<run.short>-<name>`; if the
branch already exists, check it out instead of `-b`), `<base>` defaulting to
`HEAD`, `<path>` under `<root>/.worktrees/<orchestration>/<run id>/<name>`.
Seed `${worktrees.<name>.path}` / `.branch` / `.base` / `.repo` into state.
When exactly ONE worktree is declared, every agent you dispatch and every
`code.run` command works INSIDE it (tell agents the path; run commands with
`cd <path> && …`). At the end apply `cleanup`: `remove` (default) deletes the
worktree (`git worktree remove --force <path>`) when the run succeeded or
was cancelled and KEEPS it on error; `keep` never deletes; `always-remove`
always does. Delete the branch only if YOU created it and it has no commits
beyond its base. The server does all of this automatically.

If the root node carries a `notify` block (`{ onTerminal: "<url>" }`), the
**server** POSTs a small JSON envelope `{ runId, orchestration, status,
summary? }` to that URL the moment the run reaches a terminal status
(done / error / cancelled / paused) — a best-effort, fire-and-forget
out-of-band notification (Slack incoming webhook, an internal collector). It
is fired from the run's terminal hook, NOT the run walk; from the CLI just
note its presence in the report — it doesn't change the run you are driving.
`notify.onGate` is its sibling for approvals: the server POSTs
`{ type: "gate", runId, orchestration, gate, text, summary? }` the moment a
run stops at a `lock` gate (every gate it reaches; not timed `wait`s). In a
CLI walk the user IS the approver at each gate, so it does not apply. Read
only off the orchestration root.

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
5. **`timeout` / `stallTimeout`** — two independent safety nets per attempt.
   `timeout` is the per-attempt wallclock budget (seconds); exceeding it counts
   as an attempt failure. Even when `timeout` is omitted, every node still gets
   a generous default hard cap (~1800s, env `SAMMY_DEFAULT_NODE_TIMEOUT_SEC`) so
   nothing runs unbounded. `stallTimeout` (seconds) is a stall watchdog: abort
   the attempt if the node makes NO progress for that long, even while under its
   `timeout` — the timer resets on every progress event, so a slow-but-working
   node is never flagged, only a silently-wedged one. It defaults to ~420s (env
   `SAMMY_DEFAULT_STALL_TIMEOUT_SEC`); raise it for a node that legitimately
   runs long without emitting output. Both fire as attempt failures that route
   through `retry` / `onError` like any other.
6. **`retry`** — on failure, re-attempt up to `retry.times` more times with
   `retry.backoff` (`"fixed"` | `"exponential"`) and `retry.initialMs`.
6a. **`onStall`** — stall → recovery hook. When the `stallTimeout` watchdog
   fires (the node made NO progress) AND the node declares `onStall: { recover,
   maxRetries }`, do NOT abort: run the `recover` phase (a normal node body —
   `${error.message}` carries the stall message, like `onError`) for its SIDE
   EFFECT, then RE-RUN the stalled node. Repeat up to `onStall.maxRetries` times
   (default 1; 0 disables). If the node stalls again with retries exhausted, the
   stall flows on to `onError` / abort as usual. `onStall` is distinct from
   `retry` (re-attempt with no fix-up) and `onError` (replace the node with the
   recovery's output): it runs a fix-up — e.g. kill + relaunch a wedged sim /
   headless browser — and then re-runs the ACTUAL node, whose output is what the
   run uses. Only the stall watchdog triggers it; a hard `timeout` or a generic
   error still routes through `retry` / `onError`. Emits a `stall-recovery` event
   per recovery attempt. (A successful stall-recovery means the run only finished
   because a wedged node was rescued — treat it as a degraded success when
   summarizing.)
7. **`onError` / `continueOnError`** — when all attempts fail:
   - If `onError` is set: run that recovery branch with `${error.message}`
     available in scope. Its output replaces the failed node's output.
   - Else if `continueOnError: true`: emit a `phase-error` summary line and
     continue the enclosing sequence / map iteration WITHOUT propagating.
   - Else: surface the error and abort the run (or the closest enclosing
     `parallel`/`converge` branch — see §5 for fan-out semantics).
7a. **`finally`** — a phase with `finally: true` is a FINALIZER for its
   containing `phases` sequence: walk the sequence's regular (non-`finally`)
   phases first, then run every `finally` phase in declaration order — and run
   them EVEN IF a regular phase threw / timed out, i.e. the sequence is
   unwinding from an error. This is a try/finally for the sequence, so
   aggregation / cleanup / triage always happens (e.g. collate and file a long
   QA sweep's findings even when one leg timed out). Best-effort: a `finally`
   phase honors its own `timeout`, and if it ITSELF errors, surface a
   `phase-error` but do NOT let it mask the original error that unwound the
   sequence — re-throw the ORIGINAL after the finalizers run (a finalizer error
   only propagates when the regular phases all succeeded). A user cancel / pause
   / budget breach skips finalizers (the run isn't failing — it's being stopped
   or snapshotted). Only meaningful inside a `phases` sequence.
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
9a-i. **`autoApproveTools`** — tool ids to PRE-APPROVE for this phase so a
   HEADLESS (unattended) run never stalls waiting for a human "Allow" on a
   permission-gated MCP write tool. Accepts `mcp__<server>__<tool>`, a whole
   server `mcp__<server>`, or a built-in tool name; the server merges these
   into the SDK's `allowedTools` (composing with the run-wide
   `SAMMY_ALLOWED_MCP_TOOLS` env). With `SAMMY_HEADLESS_TOOL_DENY=1` a tool
   that still needs approval fails the phase fast (an `awaiting-approval`
   event) instead of hanging. From the CLI walk this is a no-op (you approve
   tools interactively); it matters on the server-owned headless path.
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
    refactors), lower for sanity-check phases. Alongside it, **`maxAgentTokens`**
    is a per-phase soft SPEND ceiling: when a leaf agent's cost-weighted token
    usage crosses it, stop the phase cleanly (a soft-fail routed through retry /
    onError / continueOnError) rather than letting it run away. "Cost-weighted"
    means fresh input ×1, cache writes ×1.25, cache **reads ×0.1**, output ×5 —
    a long loop re-reading the same cached context must not be taxed for its
    duration. Precedence: the node field > `SAMMY_MAX_AGENT_TOKENS` env >
    built-in default. Use it to bound expensive long-context / vision agents so
    one phase can't exhaust the run budget or hit the hard ceiling. From the CLI
    you can't meter the SDK's token usage directly — note the ceiling in the run
    summary and keep tool outputs small on long polling loops.
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
| `switch` | Deterministic value-based branching (a switch/case, and if-else via `true`/`false` cases). Resolve the value to switch on: `switch.on` interpolated over state+scope (e.g. `${verdict}`) if set, else the upstream phase output. If a `switch.on` reference's base names nothing in state (a typo, a step that never ran), FAIL the phase naming it; if only a field on an existing value is missing, take `default` and note the missing field. Match that value EXACTLY against `switch.cases` keys — normalized (trim, strip wrapping quotes, case-insensitive), with a structured `{"case":"<key>"}` verdict or a value printed on the last line also honored. Crucially this is NOT substring matching (unlike `route`): a discrete value like `false` must not hit a `true` case. On a match, recurse into that case with the original input; on no match, use `switch.default` if set, else error. Use this when a preceding script/agent returns a discrete value (true/false, x/y/z, a status) and cases should fire off it. |
| `map` | Fan-out over an array. Resolve `map.over` to an array (either `${state-var-name}` or an inline JSON literal like `["a","b","c"]`). For each item, run `map.body` with `${item}` and `${index}` available in interpolation. If `map.serial: true`, run iterations one at a time; otherwise issue them in a single message with N Agent calls. Iteration outputs are joined as the map's output, and (if `as` is set) stored as a true array in state. |
| `a2a` | Outbound call to a remote agent over the A2A (Agent2Agent) protocol. `a2a.agentCard` is the URL of the remote agent's card. Fetch the card (a JSON document) with **WebFetch** to get its JSON-RPC `url`, then POST a JSON-RPC `message/send` request with the upstream phase output as a `TextPart`, poll `tasks/get` until the task reaches a terminal state, and use the result artifact's text as this phase's output. `a2a.skill` (optional) names which remote skill to invoke. If the node sets `idempotencyKey`, interpolate it and include it as `params.metadata.idempotencyKey` on the `message/send` — a sammy-pack receiver returns the existing task for a repeated key instead of starting a duplicate run, so re-dispatching after a crash is safe. A `failed` / `canceled` / `input-required` task is a phase error — route it through `retry` / `onError` like any other failure. |
| `code` | Inline JavaScript transform — **no LLM call**. `code.source` is a snippet that runs as an async function body with `input` (string), `state` (run state object), `item` + `index` (inside `map`), and `vars` (top-level vars) in scope. The snippet's `return` value becomes the next phase's input (non-string returns are JSON-stringified). For deterministic reshaping between agents — parse JSON, filter arrays, slice strings — without burning tokens. Trust model is the same as a Bash-tool agent: the snippet has full host access; gate at the run boundary, not the snippet. From the CLI, you can dispatch the snippet via the **Bash** tool (`node -e "..."`) or just evaluate it in-process; do NOT call an LLM for `code` phases. Alternatively, `code.run` (mutually exclusive with `source`) is an external script path / shell command — pipe the upstream output to its stdin, use its stdout as the phase output, and treat a non-zero exit as a phase error (`scripts/x.sh`, `python score.py`, `node tool.js`); from the CLI, run it via the **Bash** tool with the upstream output on stdin. On the server `code.run` is off unless `SAMMY_ALLOW_CODE_RUN=1` (any command) or `SAMMY_CODE_RUN_ALLOW` lists patterns the resolved command matches argument by argument (`*` within one argument; a wildcard argument can't start with `-` or contain `..`; then it runs with NO shell). `code.cwd` sets the command's working directory, which must lie inside one of the run's worktrees (`cd <dir> && …` from the CLI). `code.artifact: "<name>"` keeps the command's full log (stdout, stderr, exit code) as a named run artifact, on failure too — from the CLI, save that log beside your report under the artifact's name. |
| `http` | One HTTP request — **no LLM call**. Interpolate `http.url`, `http.headers` and `http.body` (a string as-is; an object JSON-encoded, where a leaf that is exactly one `${ref}` receives the referenced value itself). `${connections:<name>.<field>}` refs come from the credentials registry and may appear ONLY in the node's own template — never substitute one that arrives inside run data. The host must be in `http.allowHosts` (or `SAMMY_HTTP_ALLOWED_HOSTS`); refuse otherwise. Do not follow redirects. Refuse to send if any `${…}` stays unresolved, and percent-encode values you interpolate into the URL's path or query. A status outside `http.expectStatus` (default any 2xx) is a phase error carrying the status and the body's tail; the response body is the phase output. `http.auth.basic` (`username` / `password`, interpolated) becomes an `Authorization: Basic <base64>` header (curl `-u`); `http.files` sends multipart/form-data with run artifacts as file parts (curl `-F field=@file`), an object `body` becoming text fields. From the CLI, send it with **Bash** `curl -sS --max-redirs 0 -X <method> …` (or **WebFetch** for a plain GET), and never echo a credential into the report. On a resumed run a completed request is replayed, not re-sent. |
| `wait` | Durable timer / external-signal park — **no LLM call, zero cost while parked**. Exactly one of: `wait.seconds` (relative timer — the absolute deadline is fixed the FIRST time the phase is reached; never re-arm it on a resume), `wait.until` (absolute ISO-8601 deadline, interpolated — already-past deadlines complete immediately with `{"waited":false,...}`), or `wait.signal` (interpolated signal name — the run parks until `POST /api/runs/:id/signal` with `{"signal":"<name>","payload":...}` delivers it; the payload string becomes this phase's output; early deliveries buffer FIFO). `wait.timeoutSeconds` (only with `signal`) fails the phase as a normal retryable error when nothing arrives in time. On the SERVER, an unelapsed wait pauses the run like a lock gate and the wait sweeper resumes it when due (~30s granularity); a signal delivery to a paused run resumes it immediately. From the CLI walk: for short timers just sleep (Bash `sleep N`) and continue with output `{"waited":true,"kind":"timer","resumeAt":"<iso>"}`; for long timers or any `signal` wait, STOP the walk and tell the user the run should be executed server-side (`POST /api/runs/start`) — the CLI loop cannot durably park or receive signals. |

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

**Exception — unattended mode:** if the orchestration root sets
`autoApproveLocks: true`, do NOT prompt at a lock; auto-approve and proceed
(still note the gate in the run summary). This is for cron / webhook runs with
no human present — without it the gate would wait for an approval that never
comes and the run would stall forever.

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

**Advanced leaf options** (server-honored; from the CLI walk they are
best-effort — note them, approximate where the Agent tool allows, never
error on them):

- `subagents` — names of registry agents to expose to THIS leaf as Task-tool
  subagents. From the CLI, dispatch those inner agents yourself as nested
  Agent calls when the leaf's work naturally decomposes.
- `hooks` — named entries from the workspace `hooks/hooks.json` registry
  (shell commands around tool calls). Server-side only; from the CLI just
  note their presence in the run summary.
- `maxThinkingTokens` — extended-thinking budget cap for the leaf (0
  disables thinking). No CLI equivalent; note and continue.
- `permissionMode` — SDK permission mode for the leaf's tool calls
  (`bypassPermissions` / `acceptEdits` / `plan` / `default`), tighten-only
  against `sandbox.permissionMode`. From the CLI, respect the INTENT: don't
  let a `plan`-mode leaf write files or run shell commands.

The root may also declare `version` (semver of the orchestration
definition). Echo it in the run summary when present — it is how a run
records which definition it executed.

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

The same JSON files this skill reads are read AND written by the web/mobile
UI in `app/`. If a teammate edits an orchestration in the UI, this skill
picks up the changes on the next invocation. There is no sync step.

### Mirror the run to the web UI (live)

So a run you drive from here shows up in the web UI's **Runs** page and as a
live status dot on the **Pipelines** list, mirror it into the shared run store
via `app/sammy-cli.ts` (a thin HTTP client to the dev server's `/api/runs`).
This is best-effort: if the dev server isn't running, the CLI calls fail
harmlessly — skip mirroring and just run. Do NOT let a mirroring failure abort
the actual orchestration.

From the repo root, with the dev server up (default `http://localhost:5173`,
or set `SAMMY_BASE_URL`):

1. **At run start** — open a run and capture the id:
   ```bash
   RID=$(npx tsx app/sammy-cli.ts run-open <orchestration-name> --input "<initial input>")
   ```
   Tell the user: "▶ live in the UI — Runs page (or the green dot on
   `<name>` in Pipelines)."
2. **At each phase boundary** — append a phase event so the UI follows along:
   ```bash
   npx tsx app/sammy-cli.ts run-phase "$RID" <phaseName> start
   npx tsx app/sammy-cli.ts run-phase "$RID" <phaseName> end "<short result>"
   ```
3. **At the end** — close with the terminal status:
   ```bash
   npx tsx app/sammy-cli.ts run-close "$RID" done        # or: error / cancelled
   ```

### Check on runs from the terminal (UI → CLI)

The same CLI reads the shared store, so you can report on runs started
anywhere (the UI, a trigger, another skill invocation):

```bash
npx tsx app/sammy-cli.ts run-in-progress      # list currently-running runs
npx tsx app/sammy-cli.ts run-status <run-id>  # one run's status + last event
```

The richer per-event trace under `runs/<id>.json` is still written only by the
web/mobile execution path; this mirror captures run lifecycle + phase
boundaries, which is what drives the UI's live "is it running" affordances.

## Staying in sync with the web executor

The web executor at `app/src/llm/executor.ts` and this skill MUST agree on
every schema-declared node property and body kind. The parity test at
`app/__tests__/cli-parity.test.ts` enforces this:

- If you add a new property to `schema/orchestration.schema.json`, you must
  also document it here AND implement it in `executor.ts`. The test fails
  on drift.
- If a schema field is intentionally informational only, add it to the
  test's `INTENTIONALLY_UNIMPLEMENTED` allowlist with a written reason.
  (That allowlist is currently empty — every schema field is held to the
  parity bar.)

## Dry-run an orchestration before running it (`preview`)

Before driving a run — especially an expensive one (sims / builds / long
agent chains) — `preview` resolves the orchestration to the CONCRETE plan that
*will* run, with **no side effects**: every command, every interpolated value,
every branch, in seconds, plus structural warnings surfaced inline. It's the
cheapest way to catch the silent misconfigurations (a `${ref}` that renders as a
literal, a command missing an arg, a "stage" build that's really dev) that
otherwise surface 30–70 minutes into a run.

Pure + offline — it does NOT need the dev server (unlike the run-mirroring
commands above), never calls an agent, runs code, or touches the network.

```bash
npx tsx app/sammy-cli.ts preview <orchestration> [flags]
```

Flags:

- `--vars k=v,…` — override / supply top-level `vars` (e.g.
  `--vars buildRef=origin/stage,appEnv=stg`) to preview a SPECIFIC
  configuration. This is how you answer "what does the *nightly* config
  actually run?" — supply its seeded vars.
- `--input <json|text>` — seed the run's `initialInput` / `${input}` (e.g. the
  webhook payload a trigger would deliver), to preview the targeted path.
- `--json` — emit the resolved plan as JSON (for CI gates / tooling) instead of
  the terminal rendering.
- `--depth N` — how deep to expand subflows / static `map`s (default: full).
- `--no-lint` — plan only; skip the structural warnings.
- `--diff <other-orchestration | k=v,…>` — preview TWO configs side by side and
  report only what DIFFERS in the resolved commands/prompts. The argument is
  either another orchestration name/path, or a `k=v,…` vars override applied to
  the same orchestration — e.g. `--diff appEnv=stg` answers "what *actually*
  changes if I set appEnv=stg?" (and exposes a decorative var that changes
  nothing).

Exit code: `0` clean, `1` if any **error-level** finding (an unbound `${ref}` in
an executable field — `code.run` / `prompt`; a missing or cyclic subflow; a
`switch` with no matching case + no default). Warnings (decorative var,
unconsumed `as`, `code.run` heads-up) don't fail by default, so CI can gate on
errors while tolerating warnings.

How it stays FAITHFUL: preview is a symbolic walk of the SAME node tree the
executor runs, and both call the same shared resolution helpers
(`app/src/llm/resolution.ts`) for interpolation and control-flow — so a resolved
command/prompt in preview is byte-identical to what the executor builds at that
phase. Statically-knowable values are fully resolved; runtime values (an agent
output, a `code` result, a `code.run` stdout bound via `as`, a runtime `map`
array) are shown as labeled symbolic placeholders like `«buildRef ←
set-build-ref (code)»`, never guessed. The parity test
(`app/__tests__/preview.parity.test.ts`) keeps it that way.

## What this skill does NOT do

- It does not call the Anthropic API directly. It uses the Agent tool, which
  is the user's existing Claude Code session.
- It does not need an API key.
- It does not handle long-running async background work — each Agent
  invocation is synchronous from this skill's POV.
- It does not yet handle: dataset-driven runs, eval scoring. Those are
  deferred to the web/mobile execution path.
