# Repository guide for agents & contributors

`sammy-pack` is a **generalized, open-source** agent-orchestration framework.
Everything committed here must stay domain-agnostic — no app-, company-, or
deployment-specific content. That is the prime directive; the rules below exist
to enforce it.

## 1. Keep it generalized

- Only generic, reusable content belongs in version control: the engine, the
  schema, generic example orchestrations, and generic starter/template agents.
- Anything tied to a specific consumer app — its domains, screens, personas,
  tickets, environments, credentials, hostnames, device IDs — is **out of
  scope** and must never be committed, including in tests, fixtures, docs, or
  example JSON.

### Examples: in-scope vs out-of-scope

Concrete pairs — the ❌ side uses generic placeholders (`acme-`, `myapp-`)
**standing in for a real app name**; never write the real one.

| ❌ Out of scope (domain-specific) | ✓ In scope (generic) |
| --- | --- |
| Orchestration `"name": "acme-checkout-qa"` | `"name": "checkout-qa"` (or a generic shape name like `fanout-qa`) |
| A hardcoded screen: `"prompt": "Open the Acme Wallet screen and tap Pay"` | A generic reference: `"prompt": "Open the ${screen} screen and tap the primary action"` |
| A hardcoded device ID: `"hostSim": "00000000-1111-2222-3333-444444444444"` | A variable: `"hostSim": "${hostSim}"` (real value supplied per-machine via `vars` / run inputs, never committed) |
| An app-prefixed agent path: `"agent": "agents/myapp-login-qa.md"` | A generic path: `"agent": "agents/login-qa.md"` |

The rule of thumb: if swapping in a *different* app would require editing the
committed file, it isn't generic yet — move the app-specific part into `vars`
or run inputs.

## 2. `agents/` and `examples/` are ALLOWLISTS

Both directories use an allowlist `.gitignore`: `*` is ignored, and only the
generic files shipped with the project are explicitly un-ignored (`!name.md`).

- Imported, domain-specific, or per-machine agent/example sets dropped into
  these directories are **excluded by default** — that is intentional.
- **Never `git add -A`** or `git add agents/` blindly. Add files by explicit
  path. To ship a NEW generic template, add the file *and* its `!name`
  allowlist entry.

## 3. The symlink trap — read this before copying agent files

Some files under `agents/` may be **local symlinks** into an external workspace.
They appear as a typechange — `T` — in `git status`, and the symlink target is
domain-specific content.

- **Never commit a `T agents/*.md` typechange.** It replaces the generic tracked
  file with domain content.
- When a tool **copies agent files programmatically** (e.g. assembling the
  Claude Code plugin bundle), source each file from the **git-tracked blob**,
  not the working tree:

  ```sh
  git show HEAD:agents/<name>.md      # the generic, committed version
  ```

  Copying the working-tree file instead silently **dereferences the symlink**
  and bakes domain content into a committed artifact. This has happened before —
  that's why this section exists.

## 4. Publishing

- The publishable packages live in `app/packages/*` (`sammy-pack`,
  `@sammy-pack/cli`). Each controls its tarball via its `files` allowlist.
- **Publish from inside the package directory, never the repo root.** The root
  holds local-only state (a large run database, credentials, imported domain
  agents) that must never ship.
- `prepublishOnly` builds the package; don't commit `dist/` (it is gitignored).

## 5. Before you commit or push

1. Stage by explicit path, then review `git diff --cached --name-only`.
2. Scan staged content for domain / secret / PII strings — app or company
   names, API keys, tokens, emails, hostnames, device IDs.
3. For plugin/bundle agents, diff each against `HEAD:agents/<name>`. A keyword
   grep gives false positives; the blob diff is authoritative.
4. Commits are authored by the maintainer, with no
   co-author trailers.
