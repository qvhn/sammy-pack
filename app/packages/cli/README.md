# @sammy-pack/cli

Standalone CLI for the [`sammy-pack`](https://www.npmjs.com/package/sammy-pack)
orchestration engine — run JSON-defined agent workflows from the terminal,
expose them to Claude Code as MCP tools, or launch a Claude session wired into
the engine. Routes phases to Anthropic / OpenAI / Gemini per-node; no dev
server required.

## Install

```bash
npm install -g @sammy-pack/cli      # exposes `sammy` and `sammy-pack`
```

Or run once without installing:

```bash
npx @sammy-pack/cli <command> [args]
```

## Commands

```bash
sammy run <orchestration.json> [options]   # run an orchestration
sammy validate <orchestration.json>        # validate against the schema
sammy preview <orchestration.json> [opts]  # symbolic dry-run, no side effects
sammy mcp                                  # start the stdio MCP server
sammy claude [claude-args...]              # launch Claude Code, engine preloaded
sammy help
```

`sammy` and `sammy-pack` are the same binary.

## Run an orchestration

```bash
export ANTHROPIC_API_KEY=sk-ant-...
sammy run examples/ticket-triage.json --input "login button does nothing on Safari"

# route the run to OpenAI instead
export OPENAI_API_KEY=sk-...
sammy run examples/ticket-triage.json --provider openai --model gpt-4o-mini --input "..."

# one RunEvent JSON per line, pipeable into jq
sammy run examples/refinement-loop.json --json | jq -c .

# validate without running
sammy validate examples/idea-to-prototype.json
```

## Use it from Claude Code

The package bundles a Claude Code plugin — a skill, the generic agent
templates, and an MCP server — so Claude can drive the **real durable engine**:
runs hit the run store and show up in the web dashboard, rather than being
re-walked by hand.

```bash
sammy claude            # launches Claude Code with the plugin loaded
sammy claude --resume   # extra args pass straight through to `claude`
```

Under the hood the plugin spawns `sammy mcp`, a stdio MCP server exposing:

| Tool | Does |
| --- | --- |
| `list_orchestrations` | list orchestrations found in `./orchestrations` / `./examples` (or `$SAMMY_ORCH_DIR`) |
| `start_run` | start a durable run, returns a run id |
| `get_run` | fetch a run's status + summary |
| `cancel_run` / `resume_run` | stop / resume a run |

The MCP server is a per-session subprocess — **zero infrastructure** — and opens
the same `runs.db` the web UI uses, so a run started from Claude is visible in
both. To register it in another MCP client directly:

```bash
claude mcp add sammy-pack -- sammy mcp
```

## Per-node provider routing

If an orchestration sets `provider` on a node, THAT phase runs against the named
provider — the CLI just sets the default. Set the matching `*_API_KEY` for any
provider you route to.

```json
{ "name": "summarize", "agent": "agents/summarizer.md",
  "provider": "gemini", "model": "gemini-2.0-flash" }
```

## Options (`sammy run`)

| Flag | Default | Notes |
| --- | --- | --- |
| `--input "text"` | empty | Initial input for the first phase |
| `--provider` | `anthropic` | `anthropic` / `openai` / `gemini` |
| `--model` | provider default | Overrides the default model |
| `--agents-dir <path>` | `./agents` | Where to load agent `.md` files |
| `--api-key <key>` | env var | Overrides `*_API_KEY` |
| `--quiet` | off | Only print final phase outputs, not deltas |
| `--json` | off | One RunEvent JSON per line |

## Environment

| Var | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | provider keys |
| `SAMMY_ORCH_DIR` | where `list_orchestrations` looks (default `./orchestrations`, then `./examples`) |
| `SAMMY_RUN_DB` | run-store directory (the file is always `runs.db`) |

## Status

Alpha. The CLI is bundled to standalone ESM (`dist/`) with the engine inlined —
no `tsx` at runtime; it depends on the Claude Agent SDK, with `better-sqlite3` /
`pg` as optional peers for the run store. Lock gates auto-approve in `run` mode
(no human in the loop). Tool-use / subagents / MCP are Claude-specific and
no-op on non-Anthropic providers. Pin the `0.1.0-alpha.x` line.
