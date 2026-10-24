# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repository.

**Read [`AGENTS.md`](./AGENTS.md) first.** It defines the prime directive — this
is a generalized, open framework, so never commit domain- or app-specific
content — and the rules that enforce it.

Highest-leverage reminders:

- **Keep everything domain-agnostic.** Add files by explicit path; never
  `git add -A` (the `agents/` and `examples/` directories are allowlists that
  deliberately exclude imported domain sets).
- **When copying agent files, source from `git show HEAD:agents/<name>`, never
  the working tree** — a working-tree file may be a symlink to a domain
  workspace, and copying it leaks domain content into a committed artifact.
- **Publish from `app/packages/*`, never the repo root.**
- Before committing, scan staged content for domain/secret/PII strings; for
  plugin agents, diff against the tracked blob (a keyword grep gives false
  positives).
