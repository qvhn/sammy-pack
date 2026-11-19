---
name: sammy-pack-setup
description: Set up sammy-pack on this machine and prove it works. Checks Node, npm, build tools and the Claude Code login; installs dependencies; reports whether the Claude Agent SDK is behind; then validates in order — typecheck, tests, web build, a zero-token run, and one real agent run — fixing what it can and reporting what it can't. Invoke for "/sammy-pack-setup", "set up sammy-pack", "does sammy-pack work on this machine", or after pulling big changes or updating dependencies.
---

# sammy-pack-setup — install and validate on this machine

Machines differ (Node version, native build tools, Claude login, ports), so
this skill doesn't assume anything: it looks, sets up what's missing, and
then proves the result with real runs. Work from the repo root. Every step
below says how to tell it passed; stop at the first failure, fix it (see
[Troubleshooting](#troubleshooting)), and re-run that step before moving on.

## Ground rules

- **Never print secrets.** Don't `cat` `credentials.json`, `.env` files or
  `~/.claude/` contents, and don't echo tokens. Check that a key *exists*, not
  its value.
- **Don't overwrite local state.** Leave an existing `credentials.json`,
  `runs.db` and any uncommitted edits alone. Create `credentials.json` from
  the example only if it's missing and the user wants extra providers — the
  checks below don't need it.
- **Only stop what you started.** If a sammy-pack server is already running,
  don't kill it without asking. Start your own on a free port instead.
- **Clean up.** Delete the test runs you created and stop the server you
  started, so the user's Runs page looks as it did.
- **Ask before system-wide installs** (Node, Xcode tools, build-essential,
  Visual Studio Build Tools). Say exactly what you'd run.
- On Windows, use PowerShell equivalents of the commands below; the Node
  code is cross-platform.

## 1. Check the machine

Run these and record each result:

| Check | Command | Passes when |
|---|---|---|
| git | `git --version` | any version |
| Node | `node --version` | 22.13+ or 24.3+ (`.nvmrc` pins 22); odd-numbered releases such as 23 are outside React Native's range |
| npm | `npm --version` | any version |
| Claude Code | `claude --version` | installed |
| Port | `lsof -i :5173` (Windows: `netstat -ano \| findstr 5173`) | note if busy |

- **Wrong Node:** if `nvm` (or `fnm`, `volta`) is installed, run `nvm install && nvm use`
  in the repo root. Otherwise tell the user to install Node 22 LTS.
- **Claude Code missing:** runs don't need it: the Agent SDK carries its own
  copy of Claude Code. They do need a login, though, and the easiest way to log
  in is the CLI. Without the CLI, an `ANTHROPIC_API_KEY` in the environment
  works too.
- **Login:** don't try to read the login. Step 5's agent run proves it. If
  that run fails on auth, have the user type `! claude` and then `/login`.
- **`NODE_OPTIONS` set:** if it's set in the shell (some setups preload
  debuggers or loaders), run node and npm commands with `env -u NODE_OPTIONS`
  so it can't break tsx, jest or the SDK.

## 2. Install

```bash
cd app
npm ci          # exact versions from package-lock.json
```

Passes when `npm ci` exits 0 and `node -e "require('better-sqlite3')"` runs
without error inside `app/`. `better-sqlite3` is a native module: it usually
downloads a prebuilt binary, but on an unusual Node/OS pair it compiles, which
needs build tools (see Troubleshooting). The `prepare` script also points git
at `.githooks`, so the pre-push CI check runs on this machine.

## 3. Is it current?

```bash
cd app
npm outdated @anthropic-ai/claude-agent-sdk @modelcontextprotocol/sdk zod
```

Report the installed and latest versions. The Agent SDK ships almost daily,
and it carries the Claude Code runtime every run uses. The repo's Dependabot
config (`.github/dependabot.yml`) opens a grouped PR for these every Monday,
so normally the fix is to merge that PR and pull. Don't bump versions here
unless the user asks. If they do, work on a branch: `npm install
@anthropic-ai/claude-agent-sdk@latest -w . -w packages/cli`, then run step 5
in full before committing.

Also report the user's own `claude --version`. That copy is used only for
"Continue in terminal" and updates itself.

## 4. Optional local config

Only if the user asks for it:

- Extra providers or integrations: copy `credentials.example.json` to
  `credentials.json` (if missing) and let the user fill it in.
- Settings: the server reads `PORT` (default 5173), `SAMMY_REPO_ROOT` (the
  repo root, which is the default) and `SAMMY_BIND_HOST` (default 127.0.0.1;
  keep it unless they deliberately want LAN access).

## 5. Validate

Do these in order. Each one rules out a layer before the next.

**a. Types**: `npm run typecheck` in `app/`, exit 0.

**b. Tests**: `npm test -- --ci --maxWorkers=50% --forceExit` in `app/`.
Passes when the summary shows 0 failed. (It runs about 3,000 tests in a few
minutes; some are skipped on purpose.) If the user wants a quick check, run
`npx jest sdk-stream executor run-question-flow` instead, and report that
you did.

**c. Web build**: `npm run build:web`, exit 0. This creates `app/web-dist/`,
which `serve.ts` serves.

**d. Start a server you own.** First check that no sammy-pack server is
already running from this checkout: `curl -s localhost:5173/api/health`, and
`lsof -i -P | grep LISTEN | grep node` for other ports. A second server here
would share its `runs.db` and fire its scheduled triggers twice. If one is
running, ask the user whether to restart it (it's running whatever code it
started with) or to run 5e–5f against it as it is. Otherwise pick a free port
(5173 if it's free, else 5190 and up) and start one in the background:

```bash
cd app && PORT=<port> npm run serve > <scratch>/sammy-setup-serve.log 2>&1
```

Poll until `curl -s localhost:<port>/api/health` returns `"status": "ok"`
(about 30 seconds at most). If the log says the port is taken, pick another.

**e. Zero-token run**: proves the engine, the store and event streaming:

```bash
curl -s -X POST localhost:<port>/api/runs/start \
  -H 'Content-Type: application/json' \
  -d '{"orchestrationName":"smoke-test","initialInput":"setup"}'
# → {"id":"run-…"}
```

Poll `curl -s localhost:<port>/api/runs/<id>` every 2 seconds until
`status` isn't `running`. Passes when it's `done`.

**f. Real agent run**: proves the Agent SDK, the bundled Claude Code and the
login together. `examples/setup-check.json` runs a code step, one small
Haiku call (well under a cent) and a check that fails the run unless the
agent replied `SETUP-OK`:

```bash
curl -s -X POST localhost:<port>/api/runs/start \
  -H 'Content-Type: application/json' \
  -d '{"orchestrationName":"setup-check","initialInput":"setup"}'
```

Poll as above, for up to 3 minutes. Passes when the status is `done`. If it
isn't, fetch the run and read its `error` and its last `phase-error` event,
which names the cause (auth, network, model access). Don't guess.

**g. The UI** (if a browser tool is available): open
`http://localhost:<port>/`. The Pipelines page should list the examples, and
the Runs page should show the two runs above.

**h. Clean up**: `curl -s -X DELETE localhost:<port>/api/runs/<id>` for each
run you started (expect 204), then stop the server from 5d.

## 6. Report

End with one table, then one line of verdict:

| Step | Result | Notes |
|---|---|---|
| Machine | ✓ / ✗ | Node 22.x, Claude Code x.y |
| Install | ✓ / ✗ | |
| Current | ✓ / behind | SDK installed → latest |
| Types · Tests · Build | ✓ / ✗ | N passed |
| Zero-token run | ✓ / ✗ | |
| Agent run | ✓ / ✗ | cost, seconds |

Verdict: "Ready", or the one thing that's blocking and the exact command or
action that fixes it. Mention anything you changed on the machine (installed,
created, switched Node versions).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `npm ci` fails building `better-sqlite3` (gyp errors) | no native build tools for this Node/OS | macOS: `xcode-select --install`; Debian/Ubuntu: `sudo apt install build-essential python3`; Windows: Visual Studio Build Tools with "Desktop development with C++". Then `npm ci` again. |
| `NODE_MODULE_VERSION` mismatch | `node_modules` built under a different Node | `npm rebuild better-sqlite3` (or delete `node_modules` and `npm ci`) |
| `npm ci` says the lockfile is out of sync | `package.json` edited without updating the lock | Don't hand-fix. Run `npm install` on a branch, review the lockfile diff, and tell the user. |
| tsx/jest crash at startup with loader errors | `NODE_OPTIONS` set in the shell | prefix the command with `env -u NODE_OPTIONS` |
| Tests fail only on this machine | timing under load, or OS differences | re-run the failing file alone (`npx jest <name>`). If it passes alone, call it a flake and report it. If it fails alone, report the file and the error. |
| `/api/health` never answers | port taken, or a startup error | read the serve log; pick another port |
| setup-check fails with auth / 401 / "not logged in" | no Claude login | user types `! claude` then `/login` (or sets `ANTHROPIC_API_KEY`), then re-run 5f |
| setup-check fails on the `verify` step | the model answered something else | read the agent step's output; one retry is fine. If it fails twice, report what it said. |
| setup-check times out | network or proxy blocking api.anthropic.com | check `HTTPS_PROXY` and connectivity, and report |
| `402` from `/api/runs/start` | a budget cap in Settings is reached | tell the user, and don't raise it yourself |
