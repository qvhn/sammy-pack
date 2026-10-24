# agents/

User-defined agent files referenced by orchestration JSON.

Each file describes one agent: its role, the context it expects, the tools it should use, and the output it produces. The format is intentionally plain markdown with a frontmatter block — same shape on both the CLI side (the Claude Code subagent loader) and the web/mobile side (the LLM caller).

This directory is **shared** between the CLI skill at `.claude/skills/sammy-pack/` and the web/mobile UI. Edits in either place land here.

## Agent file shape (v1, draft)

```markdown
---
name: pm
description: Product manager agent. Reads a ticket and produces a spec.
input:  { kind: ticket-ref }            # optional, JSON Schema $ref or inline
output: { kind: spec }                  # optional
tools:  [Read, WebFetch, Agent]         # optional, CLI tool allowlist
model:  claude-opus-4-7                 # optional, overrides default
---

# pm

Long-form system prompt for this agent goes here.
```

See `pm.md` for a concrete example.

## Two classes of agent files live here

This directory holds two kinds of files with different lifecycles:

### Default agents — committed (templates)

The plain `.md` files in this directory (e.g. `pm.md`, `summarizer.md`,
the `judge-*` agents, `agent-designer.md`, the vendor adapters
`*-adapter.md`) are **starter / template agents**. They ship with
sammy-pack so the examples in `examples/` work out of the box and so
new orchestrations have ready-made building blocks. They're generic
across machines and developers, so they belong in version control.

### Locally-imported agents — gitignored (per-machine)

Agents you import from another repo or path are inherently
machine-specific — the symlink target is an absolute filesystem path
that won't resolve on another developer's machine. These are listed
in `agents/.gitignore` and are **not** committed. Each developer runs
the importer themselves on first clone.

Same principle as `credentials.json` at the repo root: we ship a
template, never the live, machine-tailored artifact.

## Importing agents from another workspace

Some orchestrations in `examples/` may reference agents that live in a
separate workspace (a consumer repo, a personal agent library, …).
List those names in `agents/.gitignore` so they're treated as
locally-imported and kept out of commits, then import them per machine
via **Settings → Agent sources → "Server-side scan via absolute
path"**, pointing at the external `agents/` (or `components/`)
directory. The folder-picker affordance ("Choose folder…") writes
**copies**, not symlinks.

If an imported agent reads shared context by absolute path, keep that
path stable and well-known: both the CLI runner (the Agent tool) and
the web runner (the Claude Agent SDK subprocess) resolve it the same
way via filesystem Read, which is what keeps CLI↔web parity intact.

## Membership drift safety net

`app/__tests__/agent-references.test.ts` reads `agents/.gitignore` to
learn the set of "expected to be imported locally" names. On every
test run it walks `examples/*.json` for `"agent": "agents/<name>.md"`
references and asserts:

- If `<name>` is in `agents/.gitignore` and missing → **WARN** with
  the onboarding command.
- If `<name>` is NOT in `agents/.gitignore` and missing → **FAIL**
  (real membership drift; a new orchestration added an agent ref
  whose file isn't committed).
- Dangling symlinks distinguished from missing files in the message.
