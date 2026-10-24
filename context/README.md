# context/

JSON files describing **workspaces** — pointers to data sources that agents and orchestrations read from.

A workspace pointer is **public** config: it says where data lives, not how to authenticate. Auth credentials (PATs, OAuth tokens) live in the user's local env (CLI) or app-local secure storage (web/mobile). See `docs/architecture.md`.

## Pointer shape (v1, draft)

```json
{
  "name": "my-workspace",
  "description": "Free-text — what is this workspace?",
  "connection": "github",
  "repo": "owner/repo",
  "ref": "main",
  "paths": {
    "agents": "agents/",
    "orchestrations": "orchestrations/"
  }
}
```

Fields:

- `name` — required, unique within `context/`.
- `connection` — required, identifies the connector type (`github` | `bitbucket` | `gitlab` | `local` | ...).
- `repo` — required for remote connections (`owner/name` or full URL).
- `ref` — branch / tag / commit. Defaults to the connection's default if omitted.
- `paths` — optional. If omitted, the resolver looks at the workspace root for `agents/`, `orchestrations/`, and other known directories.
- `description` — optional, human-readable.

Connector-specific fields may be added per type (e.g. a Bitbucket workspace may need `workspace` separately from `repo`). They live alongside the shared fields above.

## How agents use it

When an agent runs, it receives a list of available workspaces. It can read files from any of them via the connector. Multiple workspaces let agents pull from a code repo, a docs repo, a designs repo, and so on, without each agent baking those locations into its prompt.

See `example-workspace.json` for a filled-out example.
