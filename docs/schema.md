# Orchestration Schema

An **orchestration** is a tree of nodes. Each node is either a leaf (a single agent) or a composite (a group of child nodes). The orchestrator walks the tree from root to leaves, executing nodes in the order their parent specifies.

This is the v2 spec. The shape stays intentionally small — connectors, agents, and the execution engine layer on top of it.

## Node shape

```ts
type Node = {
  // identity
  name: string;            // required, human-readable label

  // exactly ONE of these "body" keys
  agent?:    string;       // leaf: path to an agent definition
  agents?:   string[];     // composite: serial chain of agents in this phase
  phases?:   Node[];       // composite: nested serial phases (recursive)
  parallel?: Node[];       // composite: independent parallel branches
  converge?: Node[];       // composite: parallel branches that may conflict
  subflow?:  string;       // composite: path to another orchestration JSON
  loop?:         LoopBody;        // composite: refinement loop, body runs up to N times
  conversation?: ConversationBody;// composite: alternating turns over a shared transcript
  route?:        RouteBody;       // composite: conditional branching
  switch?:       SwitchBody;      // composite: value-matched branching over labelled cases
  map?:          MapBody;         // composite: fan-out over an array from state
  code?:         CodeBody;        // leaf: non-LLM transform — `source` in a vm, or `run` (opt-in shell)
  wait?:         WaitBody;        // leaf: durable park — a timer or an external signal
  a2a?:          A2aBody;         // leaf: dispatch to a remote agent over the A2A protocol

  // optional decorators (any node)
  merger?:      string;    // only valid with `converge` — agent that resolves conflicts
  lock?:        boolean;   // gate: pause and wait for human approval before this node runs
  input?:       SchemaRef; // declared input contract (JSON Schema $ref or inline)
  output?:      SchemaRef; // declared output contract
  description?: string;

  // v2 decorators — production safety + state
  as?:      string;        // name this node's output: later nodes can read ${name}
  when?:    string;        // skip node when the interpolated predicate is falsy
  onError?: Node;          // recovery branch (with ${error.message}) if retries exhausted
  timeout?: number;        // per-attempt wallclock cap in seconds
  retry?:   RetryPolicy;   // { times, backoff?: "fixed"|"exponential", initialMs? }
  budget?:  Budget;        // { maxTokens?, maxCostUsd? } circuit breaker for this subtree
  tools?:   string[];      // declared connectors this leaf agent needs (validated at run start)
  prompt?:         string;  // literal user-message override, interpolated (replaces upstream output)
  maxTurns?:       number;  // per-phase SDK turn cap (default: the proxy's 250-turn limit)
  continueOnError?: boolean;// a failure emits phase-error but the enclosing sequence continues

  // root only
  vars?:        Record<string, string>; // values interpolated into descendant prompts as ${name}
  concurrency?: OrchestrationConcurrency; // { group, policy? } mutual exclusion across runs
  sandbox?:     Sandbox;    // execution-safety policy; also settable per node, tighten-only
};
```

A valid node has **exactly one** of `agent | agents | phases | parallel | converge | subflow | loop | conversation | route | switch | map | code | wait | a2a` — the schema's full set of 14.

## Body kinds

The five **leaves** — `agent`, `code`, `wait`, `http` and `a2a` — are where
work happens; they are also the only kinds that evaluate an `input` / `output`
contract (see [I/O contracts](#io-contracts)). The ten **composites** below
arrange other nodes.

| Key            | Children run | Notes                                                                                        |
| -------------- | ------------ | -------------------------------------------------------------------------------------------- |
| `agents`       | Serial       | Flat chain of agents inside one logical phase. Each output → next input.                     |
| `phases`       | Serial       | Recursive — each phase is itself a node. Use this when you want to nest composites.          |
| `parallel`     | Concurrent   | Branches MUST NOT touch the same outputs. Runner unions all outputs.                         |
| `converge`     | Concurrent   | Branches MAY touch the same outputs. A `merger` resolves conflicts after all complete.       |
| `subflow`      | Inlined      | Looks up another orchestration **by name** and inlines its phases at this position. State is shared with the parent. Cycles are detected. |
| `loop`         | Iterative    | Refinement: body runs up to N times, optional stop-signal via `until`.                       |
| `conversation` | Iterative    | Alternating turns between participant agents over a shared transcript.                       |
| `route`        | Conditional  | Router agent (or substring match) picks one of N labelled branches.                          |
| `switch`       | Conditional  | No agent: the interpolated `on` expression is matched against the `cases` keys. Deterministic sibling of `route`. |
| `map`          | Fan-out      | Run body once per item in an array drawn from state. Default parallel, `serial: true` opts out. |
| `code`         | Leaf         | Non-LLM transform. `source` is inline JS in a `node:vm` with no ambient I/O; `run` is an external command and needs `SAMMY_ALLOW_CODE_RUN=1` or a matching `SAMMY_CODE_RUN_ALLOW` pattern. |
| `http`         | Leaf         | One HTTP request, no model — a write-back, a chat post, an internal API call. Host allowlist, no redirects, credentials from the registry. |
| `wait`         | Leaf         | Durable park at zero cost: `seconds` / `until` (timer) or `signal` (external). Survives restarts on a server-owned run. |
| `a2a`          | Remote leaf  | Dispatch the phase to a remote agent over the A2A protocol. `agentCard` is the remote card URL; the task result becomes this phase's output. |

### `agents` vs `phases`

Both run children serially. The distinction is structural:

- `agents: ["a", "b"]` is a flat chain of agent paths inside a single phase. Lightweight.
- `phases: [<node>, <node>]` is a list of full nodes, each with its own name, gates, and I/O contracts. Use when each step is a meaningful unit you might want to inspect, gate, or swap independently.

### `parallel` vs `converge`

The orchestrator can't always know whether two agents' writes will collide, so the config declares intent:

- `parallel` → "I promise these don't share outputs." Runner errors out if it detects a collision.
- `converge` → "These may share outputs. A `merger` handles the conflict."

For v1, omitting `merger` on a `converge` causes the run to fail on conflict. Future merger strategies may include `last-write-wins`, `three-way-merge`, or an agent path.

### `loop` — refinement

```jsonc
{
  "name": "draft-and-polish",
  "loop": {
    "body":            { "name": "draft", "agent": "agents/writer.md" },
    "maxIterations":   5,
    "until":           "[DONE]",
    "whileOutput":     "needs-work",
    "judge":           "agents/critique.md",
    "retryOnFailure":  true
  }
}
```

The body runs up to `maxIterations` times. Each iteration's output is the next iteration's input. The loop exits as soon as any stop condition triggers:

- **`until`** — output contains this string (case-insensitive)
- **`whileOutput`** — exit when the output STOPS containing this string (loops while it does)
- **`judge`** — agent path; runs after each iteration with the body's output, replies `STOP` or `CONTINUE`. Lets the LLM decide.
- **`retryOnFailure`** — if any phase inside the body errors, treat the error as the iteration output and retry (up to `maxIterations`). Without this, an error ends the whole run.

Multiple conditions can be combined; any one ends the loop. Useful for "write → critique → rewrite until good", "retry until tests pass", and similar refinement patterns.

### `conversation` — alternating turns

```jsonc
{
  "name": "debate",
  "conversation": {
    "participants": ["agents/critic.md", "agents/writer.md"],
    "rounds":       4
  }
}
```

Participants alternate in order. Each turn the next participant sees the full transcript (initial input + every prior `[name]\n...` block) and produces their reply. After `rounds` turns the conversation ends; the full transcript is the composite's output.

### `route` — conditional branching

```jsonc
{
  "name": "triage",
  "route": {
    "router":   "agents/router.md",
    "branches": {
      "bug":     { "name": "fix",      "agent": "agents/dev.md" },
      "feature": { "name": "plan",     "agent": "agents/dev-lead.md" },
      "design":  { "name": "design",   "agent": "agents/uxui.md" }
    },
    "default":  { "name": "escalate",  "agent": "agents/escalate.md" }
  }
}
```

If `router` is set, it classifies the input and emits a branch name (substring-matched against branch keys, case-insensitive). If absent, the *raw input* is matched against keys. The matching branch runs. `default` is invoked when nothing matches; without `default`, the run fails with a clear error.

### `switch` — value-matched branching

```jsonc
{
  "name": "by-verdict",
  "switch": {
    "on": "${verdict}",
    "cases": {
      "approve": { "name": "ship",   "agent": "agents/release.md" },
      "reject":  { "name": "revise", "agent": "agents/dev.md" }
    },
    "default": { "name": "escalate", "agent": "agents/escalate.md" }
  }
}
```

The deterministic sibling of `route`: no agent decides. `on` is interpolated over run state and scope, and the first case whose *normalized* key equals the normalized value runs. Omit `on` and the upstream phase output is the value. `true` / `false` keys give a plain if-else. `default` runs when nothing matches; the validator refuses a `switch` that is neither total nor defaulted (the same `make routing total` rule `route` gets). If an `on` reference's **base** names nothing in the run — a typo, or a binding whose step never ran — the phase **fails** naming it, rather than letting the literal `${…}` fall through to `default` (a default that does real work, like filing a ticket, would otherwise do it silently on every run). A missing **field** on a value that exists — an empty search result, a map item without an optional field — still takes `default`, as it always has; the `route-decision` event records which fields were missing.

### `subflow` — compose orchestrations

```jsonc
{
  "name": "C",
  "phases": [
    { "name": "step-1", "subflow": "A", "as": "a_out" },
    { "name": "step-2", "subflow": "B", "description": "Sees ${a_out}." }
  ]
}
```

`subflow: "A"` looks up orchestration A by name and inlines its phases at this position. **State is shared with the parent**: A can read `${name}` set upstream in C, and A's own `as` writes propagate back to C for nodes after the subflow.

Composition rules:

- **By name, not path.** The same name you see in the pipeline picker / chip strip.
- **Cycle detection.** If A subflows B and B subflows A, the run errors at the second entry with a clear "circular subflow reference: A → B → A" message.
- **Decorators wrap the subflow.** `retry`, `timeout`, `onError`, `when`, `budget`, `as` on the subflow node apply to the whole nested orchestration. Decorators inside the subflow's own nodes still work as usual.
- **The subflow itself is a composite** — it emits `composite-start { kind: "subflow" }` / `composite-end` events around the inner phase events so the run viewer shows where the boundary is.

See `examples/compose-pipeline.json`.

### `map` — fan-out over an array

```jsonc
{
  "name": "summarize-each-doc",
  "map": {
    "over":   "${docs}",
    "body":   { "name": "summarize", "agent": "agents/summarizer.md" },
    "serial": false
  }
}
```

The body runs once per item in the array `${docs}` (or any state variable holding an array, or an inline JSON array literal in `over`). Inside the body, `${item}` and `${index}` are available. Outputs are joined with `\n\n---\n\n` for the downstream pipe (matching `parallel` semantics). Use `serial: true` to run one-at-a-time instead of all-at-once.

### `code` — non-LLM transform (leaf)

```jsonc
{
  "name": "pick-titles",
  "code": { "source": "return JSON.parse(input).items.map(i => i.title).join('\\n');" }
}
```

For deterministic reshaping between agents — parse JSON, filter an array, slice a string — without paying for a model call. Exactly one of:

- **`source`** — inline JavaScript run in a `node:vm` context with **no ambient I/O**: only `input` (string), `state`, `item` / `index` (inside a `map`), `vars` and the JS built-ins are in scope. No `require`, `process`, `fetch`, network or `fs`. `return` a value; objects are JSON-stringified. CPU-bounded by `sandbox.maxRunSeconds`, output by `sandbox.maxOutputBytes`.
- **What a command can see.** Everything a run records is scrubbed of every secret in the registry — values, secret-named `env` / `fields` entries — not only the ones the run was given, and of the server's secret-looking environment values (plain configuration like a region is left alone); `SAMMY_CODE_RUN_ENV` additionally limits a command's environment to a base set (`PATH`, `HOME`, temp dir, locale) plus the names it lists. Neither stops a command from reading files your user can read — run untrusted, agent-written code in a container.
- **`run`** — an external command. **Disabled by default.** `SAMMY_ALLOW_CODE_RUN=1` allows any command, through a shell. `SAMMY_CODE_RUN_ALLOW` instead lists patterns (newline- or `;`-separated: `npx jest *`, `mvn -q -Dtest=* test`) the RESOLVED command must match **argument by argument**: both are split into argv, the counts must be equal, and `*` matches within one argument only — so a value cannot add arguments. An argument a wildcard supplies from its first character may not start with `-` (no smuggled options like `--config=…`) and no wildcard argument may contain a `..` path segment. A matching command runs **without a shell**, so `;`, `&&`, `|`, `$(…)` and redirects are literal arguments. Quote a value that may contain spaces in the template (`npx jest "${input}"`). (A pattern like `sh -c *` re-opens everything; keep patterns as tight as the job allows. On Windows, `.cmd` shims such as `npx` cannot be spawned without a shell — allow the real executable.) Upstream output → stdin, stdout → this phase's output, a non-zero exit → a phase error. The node's `timeout` and stall window kill the command itself, raising the same errors the watchdogs would (so `onStall` recovery still applies); output on stdout OR stderr counts as progress (jest and mvn report on stderr). With exactly one root `worktrees` entry, the command runs inside that worktree. Prefer an agent with the Bash tool, which the sandbox policy governs, for open-ended work.
- **`cwd`** (with `run`) — the working directory, interpolated (`${worktrees.app.path}/mobile`) and required to lie inside one of the run's root `worktrees` (real paths, so a symlink cannot lead out). For runs with several worktrees, where there is no default; with several, a relative path is refused — start it with `${worktrees.<name>.path}`. Keep it author-controlled — `${worktrees.<name>.path}` plus a literal sub-path; the validator warns when it is built from `${input…}`.
- **`artifact`** (with `run`) — keep the command's full log (stdout, stderr, exit code — or the timeout that killed it) as a named run **artifact**, on failure as well as success: `GET /api/runs/{id}/artifacts` lists them, `?name=<artifact>` serves one. Inside a `map` / `loop` / subflow the name is scoped like a checkpoint key (`<map>[2]/repro-log`), so every iteration's log is fetchable. Scrubbed of secrets, then bounded to its tail (`SAMMY_ARTIFACT_MAX_BYTES`, default 256 KiB), with a per-run total (`SAMMY_ARTIFACT_RUN_MAX_BYTES`, default 8 MiB). The use case is evidence: a failing reproduction's output, attached to a ticket.

`node:vm` is **not a security boundary** — the context is handed real host objects, so `source` is functionally equivalent to `run` for a malicious author. See `SECURITY.md`. The validator also warns when a `code` body reads a nondeterministic source (`Date.now`, `Math.random`), because checkpoint replay must be faithful (`nondeterministic-code`).

### `http` — one HTTP request (leaf)

```jsonc
{
  "name": "write-back",
  "http": {
    "url": "https://errors.internal.example/groups/${input.groupId}",
    "method": "PATCH",
    "headers": { "authorization": "Bearer ${connections:errors-db.value}" },
    "body": { "status": "ticketed", "ticket": "${ticket.key}" },
    "allowHosts": ["errors.internal.example"]
  }
}
```

The deterministic edges of an automation — record a status in the system that raised the event, post to a chat webhook, call an internal API — without spending an agent turn. The response body is the phase output; a status outside `expectStatus` (default: any 2xx) is a phase error carrying the status and the body's tail, so it flows through `retry` / `onError`.

- **Host allowlist.** The target host must be in the node's `allowHosts` or in `SAMMY_HTTP_ALLOWED_HOSTS` (exact names, or `*.example.com` for subdomains); with neither, the request is refused. URLs are interpolated from run state, which can carry an inbound payload — this is what stops an event from pointing the request anywhere the server can reach.
- **No redirects.** A 3xx is returned as-is (a failure unless listed in `expectStatus`), so an allowed host cannot bounce the request and its credentials elsewhere.
- **Credentials come from the template only.** `${connections:<name>.<field>}` resolves against the credentials registry on the node's own `url` / `headers` / `body` — never on values interpolated from run state — and every resolved secret is scrubbed from the run's output.
- **Body.** A string is sent as-is; an object is JSON-encoded with `content-type: application/json`, its string leaves interpolated, and a leaf that is *exactly* one `${ref}` receives the referenced value itself (a number stays a number).
- **No placeholders, no path rewriting.** A request with an unresolved `${…}` is refused rather than sent with the literal text. How an interpolated URL value is encoded depends on where it lands: at the very start (`${vars.baseUrl}/x`) it is raw; in the query or fragment it is fully percent-encoded (no injected `&admin=true`); anywhere else — the path, or right after the host (`${base}${path}`, `http://${host}/`) — everything that could redirect the request (`?`, `#`, `@`, `\`, whitespace) is encoded while `/`, `:` and `[ ]` stay, so `repos/${input.repo}` with `acme/widgets`, ports and IPv6 hosts work, and a `..` segment is refused. The resulting host must still pass the allowlist. A value placed right after the host can choose any path on that host — put a literal path segment before it (`/groups/${id}`) to bound where it can point.
- **Basic auth.** `"auth": { "basic": { "username": "${connections:jira.fields.email}", "password": "${connections:jira.value}" } }` builds the `Authorization: Basic …` header Jira Cloud and Bitbucket API tokens need (the step cannot base64-encode in a template otherwise). The encoded value is scrubbed like the password.
- **File uploads.** `"files": [{ "artifact": "repro-log", "filename": "repro.txt" }]` sends multipart/form-data with run artifacts (`code.artifact` logs) as file parts — e.g. Jira's `POST /rest/api/3/issue/{key}/attachments` (with an `X-Atlassian-Token: no-check` header). An object `body` becomes text fields beside them. An artifact recorded before an approval gate is read back from the stored run, and a **fork** carries the artifacts of the phases it replays into its own record. An artifact the run's artifact budget dropped fails the upload instead of attaching the budget notice.
- **Branch on the response directly.** The output is the raw body, but dotted references parse JSON text: after `"as": "count"` on a `POST …/search/approximate-count`, `switch.on: "${count.count}"` resolves without a `code` step, as does `${found.issues.0.key}` after a search. (A field the response lacks takes `default`, recorded on the `route-decision` event; a misspelled binding name fails the `switch`.)
- **Bounded.** `timeoutSeconds` (default 30) and `maxResponseBytes` (default 1 MiB).
- **Never re-sent on resume.** Like every leaf, a completed request is checkpointed; a run resumed past a later gate replays its output instead of posting twice.

### `wait` — durable park (leaf)

```jsonc
{ "name": "cool-off",    "wait": { "seconds": 900 } }
{ "name": "at-deadline", "wait": { "until": "${deadline}" } }
{ "name": "await-qa",    "wait": { "signal": "qa-passed", "timeoutSeconds": 86400 } }
```

The run parks at **zero cost** until a timer elapses or an external signal arrives. On a server-owned run it snapshots and pauses exactly like a `lock` gate, so it survives a restart; the server's wait sweeper resumes it when due (~30 s granularity). Exactly one of:

- **`seconds`** — relative timer. The absolute deadline is computed once when the phase is first reached and persisted, so a restart or an early resume never re-arms the clock.
- **`until`** — absolute ISO-8601 deadline, interpolated. An already-past deadline completes immediately.
- **`signal`** — park until `POST /api/runs/{id}/signal` delivers a matching `{signal, payload}`; the payload becomes this phase's output. Signals that arrive *before* the wait is reached are buffered durably and consumed FIFO. Requires a server-owned run — an in-browser run has no signal ingress. `timeoutSeconds` (signal only) turns a no-show into a normal retryable phase error, so it flows through `retry` / `onError` / `continueOnError`.

## Variables & state

Any string field that the runtime interprets (the input string fed to an agent, the agent's system prompt, `when` predicates, `map.over`) is **interpolated** before use. Syntax: `${name}` and `${name.path}` for dotted lookups into objects.

State is populated two ways:

- **`as: "name"`** on any node — after the node succeeds, its output is stored under that name. Later nodes can read it as `${name}`.
- **Reserved scope vars**:
  - `${input}` — the immediate predecessor's output (also implicit as the agent's user message)
  - `${item}`, `${index}` — inside a `map` body, the current array element / position
  - `${error.message}` — inside an `onError` recovery branch, the failure message

Unknown references render literally (`${unknown}` is left in place) so failures are visible rather than silent.

### Parameterized dispatch (`${var}` in structural fields)

Interpolation also applies to the **path/name** fields that pick what runs, not just to prompt text — so one orchestration can dispatch to a different agent or sub-orchestration per item/branch instead of needing N near-identical copies:

- `agent: "agents/${component}-dev.md"` and each entry of `agents: [...]`
- `subflow: "${track}"` (resolved before the by-name lookup and cycle check)
- `route.router` and `loop.judge` agent paths

The field is resolved against the current scope (`as` state, plus `${item}`/`${index}` inside a `map`) right before the registry lookup. A literal path with no `${...}` is unchanged. Edit-time agent-existence validation skips parameterized paths (they can only be checked at run time). Example: `examples/parameterized-review.json` fans a `map` body out to `agents/${item}.md`, dispatching to a different specialist per item.

Example: build state across phases, then use it.

```jsonc
{
  "name":   "spec-then-impl",
  "phases": [
    { "name": "spec",   "agent": "agents/pm.md",  "as": "spec" },
    { "name": "design", "agent": "agents/uxui.md", "as": "design" },
    { "name": "impl",   "agent": "agents/dev.md",
      "input": { "type": "string" },
      "description": "User message becomes: <spec>${spec}</spec>\n<design>${design}</design>" }
  ]
}
```

## Production decorators

These decorate any node. They compose in this order (outermost first): `when` → `lock` → `budget` → `retry` → `timeout` → `onError` → `as`.

### `when` — conditional skip

```jsonc
{ "name": "deploy", "agent": "agents/deploy.md", "when": "${approval}" }
```

Skip the node when the interpolated predicate is falsy (`""`, `"false"`, `"0"`, `"null"`, `"undefined"`, `"no"`). Skipped nodes don't update `lastOutput` — previous output flows through unchanged.

### `timeout` — per-attempt wallclock cap

```jsonc
{ "name": "fetch", "agent": "agents/fetcher.md", "timeout": 30 }
```

If the agent's stream doesn't finish in `timeout` seconds, fail with `TimeoutError`. Timeouts compose with `retry` (each attempt gets its own deadline) and `onError`.

### `retry` — auto-retry on failure

```jsonc
{
  "name":  "call-api",
  "agent": "agents/api-caller.md",
  "retry": { "times": 3, "backoff": "exponential", "initialMs": 500 }
}
```

On any node-level failure (including `TimeoutError`), retry up to `times` more attempts. `backoff: "exponential"` doubles delay each time; `"fixed"` keeps it constant. Distinct from `loop.retryOnFailure` which is iteration-level.

### `onError` — recovery branch

```jsonc
{
  "name":   "risky",
  "agent":  "agents/risky.md",
  "retry":  { "times": 2 },
  "onError": {
    "name":  "fallback",
    "agent": "agents/safe-fallback.md"
  }
}
```

If `risky` fails *after* all retries are exhausted, run `fallback` instead. `${error.message}` is available inside the recovery branch. The recovery's output replaces the failed node's output, and the run continues.

### `budget` — token/cost circuit breaker

```jsonc
{
  "name":   "expensive-loop",
  "loop":   { "body": { ... }, "maxIterations": 10 },
  "budget": { "maxTokens": 100000, "maxCostUsd": 5.00 }
}
```

Caps total token usage / cost while inside this subtree. Crossing the limit aborts the run with `BudgetExceededError`. Either limit is optional; budgets are *not* retried.

### `tools` — declared connector dependencies

```jsonc
{ "name": "open-pr", "agent": "agents/git-shipper.md", "tools": ["github"] }
```

Only valid on leaf `agent` nodes. At run start the executor checks every declared tool against the workspace's configured connectors and emits a `tools-warning` event for missing ones. (Hard-fail validation will land when the connector registry is fleshed out.)

### `prompt` — literal message override

```jsonc
{ "name": "summarize", "agent": "agents/writer.md", "prompt": "Summarize ${spec} in 3 bullets." }
```

Replaces the upstream `lastOutput` as this phase's user message. Interpolated against run state and scope (`${item}`, `${index}`, `${input}`), so it is the way to feed an agent something other than "whatever the previous phase said".

### `maxTurns` — per-phase turn cap

```jsonc
{ "name": "drive-ui", "agent": "agents/ui-qa.md", "maxTurns": 400 }
```

Caps the SDK turns one phase may take. Defaults to the proxy's 250-turn limit; raise it for agents that drive long iterative flows. Distinct from the cost-weighted token ceiling (`SAMMY_MAX_AGENT_TOKENS`), which bounds spend rather than turns.

### `continueOnError` — log it and move on

```jsonc
{ "name": "optional-lint", "agent": "agents/linter.md", "continueOnError": true }
```

A failure inside this phase emits a `phase-error` event, and the enclosing sequence or `map` iteration carries on instead of ending the run. For "report it, don't block" passes. The failed attempt's spend is still charged.

### Root-only: `vars`, `concurrency`, `sandbox`, `limits`, `worktrees`

- **`vars`** — `{ "name": "value" }` interpolated into descendant prompts as `${name}`. Read only off the root. Use it to de-duplicate a value that appears in many phases rather than editing each one.
- **`concurrency`** — `{ "group": "<opaque token>", "policy"?: "skip" | "queue" | "cancel-existing" }` (default `queue`). Runs whose root declares the same `group` never run concurrently; `policy` decides what a fire does when the group is busy. The group is opaque — the framework knows nothing about the resource it stands for. It may be a **template** over the fire's input — `"group": "triage:${input.fingerprint}"` — giving one active run *per key* rather than per orchestration; a fire whose input lacks the field joins the unresolved literal group, so it is serialized rather than let through. The payload only chooses what follows the template's literal prefix: a template with NO literal prefix (`"${input.repo}"`) is namespaced to its own orchestration (`tmpl:<orchestration>:<value>`), so an event cannot name — or, under `cancel-existing`, cancel — another orchestration's group. Enforced at the server start-gate, so server-owned runs only. Read only off the root.
- **`limits`** — `{ "maxRunsPerDay"?, "maxCostUsdPerDay"?, "maxCostUsdPerMonth"? }`, checked when a **trigger** fires. Usage counts every run of the orchestration, manual starts included; a trigger fire over a limit is held — re-queued, not dropped, no retry attempt spent — until the window rolls over (server-local day / month, like the workspace budget), and a cron / polling tick is skipped instead of held. Manual starts are never held. The check-and-start is serialized per orchestration through the store-backed lock, so concurrent fires (and a server plus a worker) cannot overshoot. `GET /api/orchestrations/{name}/intake` shows today's usage against them. See [triggers.md → Intake controls](triggers.md#intake-controls).
- **`worktrees`** — `[{ "name", "repo", "base"?, "branch"?, "cleanup"? }]`: an isolated git worktree per run, per entry. Before the run starts, each `repo` (a local repository, absolute or relative to the workspace root — or a repository URL, which resolves to the clone of it found directly under `SAMMY_REPO_ROOTS`, default `~/git`, `~/src`, `~/code`, `~/projects`, `~/Developer` and the workspace's parent; with none the run fails saying so, and the Run dialog offers to clone it there) gets a fresh worktree under `<root>/.worktrees/<orchestration>/<run id>/<name>` (`SAMMY_WORKTREE_DIR` moves it) on a new branch — `branch` is a template over `${run.id}`, `${run.short}`, `${orchestration}`, `${worktree.name}` and `${input.<field>}` (default `sammy/<run.short>-<name>`, e.g. `sammy/ij2x55-repo`; an existing branch is checked out and continued), started from `base` (default the repo's `HEAD`). Phases see `${worktrees.<name>.path}` / `.branch` / `.base`, every agent and `code.run` subprocess gets `SAMMY_WORKTREE_<NAME>`, and when exactly one is declared it is the working directory of agents and `code.run`. A resumed leg finds the same worktree again; a `worktrees-ready` event records where each one is. A leg that REPLAYS earlier phases but cannot find their worktree — a **fork** (which gets a new run id), or a resume after the tree was removed — fails instead of silently continuing on an unedited checkout. At the end, `cleanup` decides: `remove` (default) deletes the worktree when the run is `done` or `cancelled` (a cancel while paused at a gate included) and **keeps it on `error`** for inspection — detached from its branch, so a later run for the same key can take the branch; `keep` never deletes; `always-remove` always does. A worktree of a run that is interrupted and never resumed is not swept automatically — `git worktree list` / `git worktree prune` in the repository. A branch is deleted with its worktree only if this run created it and it has no commits beyond its base — committed work is never thrown away. Git is invoked with argument lists, never a shell, so a branch name derived from a payload cannot inject a command.
- **`sandbox`** — execution-safety policy: a tool allowlist, a Bash command denylist, a network toggle and a permission-mode floor. Set it at the root for a run-wide default; set it on a node to **tighten** (never widen) it for that subtree. It is policy-level, not OS-level — see `SECURITY.md` and `docs/architecture.md`.

## Locking

`lock: true` on any node pauses execution and waits for explicit human approval before entering that node. Locks can decorate any node, root or nested — not just the top level.

## I/O contracts

Each node may declare an `input` and `output` schema.

- Contracts are **opt-in** for v1 — flows with no declared I/O are allowed.
- **Enforced on LEAF nodes only.** `agent`, `code`, `wait`, `http` and `a2a` evaluate their contracts at run time, and a mismatch is a phase error (so it flows through `retry` / `onError` / `continueOnError` like any other failure). The composites — `phases`, `parallel`, `converge`, `loop`, `conversation`, `route`, `switch`, `map`, `subflow`, `agents` — **ignore** them. Declaring an `output` contract on a `map` or a `phases` node is the natural place to type a fan-out's or a sub-pipeline's result, and it is not checked.
- The validator warns rather than staying silent about that: a contract on a kind the executor never consults raises `composite-contract` (advisory — register-time and in `preview`, not a hard failure).
- Typing every load-bearing handoff is strongly recommended; it's what makes phases composable. Swap a `dev-agent` for a different agent with the same I/O contract and the flow still runs unchanged.

## Top-level

The root of an orchestration file is itself a node. Conventionally the root carries `name`, `description`, and one composite key (usually `phases`).

```json
{
  "name": "ticket-to-pr",
  "description": "Standard ticket-to-PR flow",
  "phases": [ ... ]
}
```

## Example

See `examples/ticket-to-pr.json` and
`examples/parallel-research-then-build.json`.
