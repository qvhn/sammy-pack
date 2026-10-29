# Harness runs

An orchestration normally runs as a **pipeline**: the engine walks the tree and
gives every agent step its own agent. It can also run as a **harness**: one
agent follows the orchestration's steps and does each step itself — with the
skill a step names, or by doing the step's task from its agent file and prompt.
The engine stays the referee: it checks the order, runs script / HTTP / wait
steps exactly as written, holds the gates, checkpoints every finished step and
decides whether the run is complete.

Choose it per run (the Run dialog's **How to run**, or `execution` on
`POST /api/runs/start`) or per orchestration:

```json
{
  "name": "ticket-to-pr",
  "execution": "harness",
  "harness": { "follow": "strict" },
  "phases": [
    { "name": "triage", "skill": "triage-ticket" },
    { "name": "plan", "agent": "agents/dev-lead.md", "as": "plan" },
    { "name": "checks", "code": { "run": "npm test" } },
    { "name": "open-pr", "agent": "agents/github-adapter.md", "lock": true }
  ]
}
```

## How the steps run

| Step | In a harness run |
| --- | --- |
| an agent step | the harness does it, with the agent file as its guidelines and `prompt` as its task |
| a step with `skill` | the harness runs that skill (a step may name only a skill — it then runs in harness mode only) |
| `code` / `http` / `wait` / `a2a` | the engine runs it exactly as written when the harness asks (`run_step`) |
| `lock: true` | the run stops for approval before the step, like a pipeline; a locked section, `parallel` or loop guards every step in it |
| a `when` that is false | the engine skips the step |
| a `phases` section | its steps, in order |
| a `parallel` of single steps | those steps, in any order among themselves |
| a `loop` of plain steps (no `judge`, no `retryOnFailure`) | the harness does each pass; after each one the engine applies `until` / `whileOutput` / `maxIterations` and opens the next pass or moves on |
| `map`, `route`, `switch`, `conversation`, `converge`, `subflow`, a judged loop | one step the engine runs as written — its agent steps get their own agents, as in a pipeline |

The agent works through step tools: `list_steps`, `start_step` (the engine
checks the order and returns the step's guidelines, task, input, tools and
output format), `complete_step` (checked against the step's `output` schema),
`fail_step`, `skip_step` (advisory only) and `run_step`. Only the active
step's declared tools work while it is active — the sandbox still applies —
and between steps the agent can only read.

## How strictly

| `harness.follow` | Meaning |
| --- | --- |
| `strict` (default) | in the declared order; a step starts only once the one before it is done |
| `loose` | any order, and a finished step can be redone — but every required step must be done |
| `advisory` | the steps are a guide; a step may be skipped with a reason, and the run ends **degraded**, naming it |

Gates, budgets and the sandbox hold in every mode. Which value applies, highest
first: the run's own choice → the orchestration's `harness.follow` → the
workspace default (**Settings → Harness runs**, stored server-side in
`harness.json`, so triggers follow it too) → `strict`. With
`harness.lockFollow: true` a run may only make it stricter. The run page shows
the value it used and where it came from.

## Durability

Each finished step is a checkpoint (`harness/<step>`, per pass for a repeated
loop: `harness/<loop>@<pass>/<step>`). A gate or a durable wait ends the
agent's session leg and pauses the run; the resumed leg continues the **same**
Claude Code session, so the agent remembers the run. A restart resumes from the
checkpoints the same way.

An agent that stops before the run is done is told to carry on twice; then the
run fails, naming the steps not done. A required step that failed ends the run
with that failure.

## Taking a run over in a terminal

The run page offers **Take over in a terminal** while a harness run is going
(and **Approve & continue in a terminal** at a gate). The server's agent stops
at the next safe point — never in the middle of an engine step — and the run
page shows a command that opens the same session in Claude Code:

```sh
cd '<the run’s worktree>' && claude --resume <session> --mcp-config '{…sammy…}' …
```

The terminal gets the same step tools, served on `127.0.0.1` for that terminal
leg only, behind a one-time token; the engine still checks the order and holds
the gates, and the run page follows along. **Open in Terminal** opens the
window for you when the server runs on your machine. **Hand back to the
server** ends the terminal's leg and the server's agent continues the session.
A terminal that calls no step tool for `SAMMY_HARNESS_TERMINAL_IDLE_SEC`
(default 30 minutes) pauses the run.

In the terminal, Claude Code's own permissions govern its tools — the per-step
tool limits are the server agent's.

## Trade-offs

- **One context.** Later steps know what earlier ones found without passing
  outputs around — but that context grows across the run. On small
  `ticket-to-pr` changes a harness run cost about the same as the pipeline up
  to 30% more (cache reads of a growing conversation), in about the same
  time. Long sweeps belong in an engine step (a `map`, a script).
- **Spend is charged as it happens**: each step's `phase-end` carries what the
  agent spent on it (output tokens settle at the end of a session leg, so the
  leg's own row carries the rest), and a step's `budget` holds mid-step.
- **One session, one process.** Every credential a step declares is in the
  session's environment for the whole run (the run says so when it starts),
  and the steps' MCP servers and hooks are attached to the whole session.
- **Per-step model choice** isn't possible in one session; `harness.model` sets
  the agent's model.
- A server harness run needs the server's Claude Code (SDK) path — the
  browser executor refuses it. The `sammy-pack` CLI skill walks a harness
  orchestration by being the harness itself: it does each step in the session
  you run it from.
