# Demo walkthrough

A script for showing sammy-pack end to end: a real ticket becomes a pull
request, then the intake add-ons — scrubbing, duplicate suppression, one run
per key, pause, limits, approval notifications, per-run worktrees and
artifacts. Part 1 uses your own Jira and GitHub; parts 2 and 3 run entirely on
your machine.

| File | What it is |
| --- | --- |
| `demo.env` | The settings the add-on demos need (no secrets). |
| `sink.mjs` | A local stand-in for a chat webhook and a ticket tracker, with an inbox page. |
| `setup.sh` | Creates a throwaway repository with a failing test. |

## 0. Before you record

```sh
cd app && npm install && cd ..                 # once
node demo/sink.mjs &                           # inbox on http://127.0.0.1:5199/
set -a; source demo/demo.env; [ -f demo/demo.local.env ] && source demo/demo.local.env; set +a
./sammy-pack restart                           # http://localhost:5173
./demo/setup.sh                                # prints the sample repo path
```

Open three tabs: the app (`http://localhost:5173`), the inbox
(`http://127.0.0.1:5199/`), and a terminal.

For part 1 you also need:

- **Jira:** a connection of kind `jira` (or `atlassian`) with your site URL,
  account email and an API token — add it under **Configure → Connections**,
  or in `credentials.json` at the repo root (gitignored).
- **GitHub:** `gh auth status` showing you logged in, and a repository you can
  push to, cloned locally. A small throwaway repo makes the cleanest demo.
- A Jira ticket that asks for a small, concrete change in that repository.
- **Settings → Agent tools (advanced)** switched on. `ticket-to-pr` declares
  the tools each step may use (edit + shell for `implement`, read + shell for
  the others); without the switch they are stripped and the run shows a
  `tools-warning`. A root `sandbox` refuses force-pushes and hard resets.
- A headless Chrome or Chromium for QA's screenshots (macOS: Google Chrome
  installed is enough).

The boot banner in `./sammy-pack logs` should read
`code.run: ALLOWLISTED, no shell — 1 pattern(s)`.

## 1. A ticket becomes a pull request (`ticket-to-pr`)

1. **Pipelines → ticket-to-pr → Graph.** Show the shape: `plan` → (`answers`,
   only if the plan has a blocking question) → `build`, a loop of
   implement → review + QA in parallel → decide, up to three passes →
   `open-pr`, behind your approval.
2. **Run.** Give it the work and the repository, in whatever form you have
   them. The work: a Jira key or link (even a board link), a GitHub issue
   link, or a sentence typed straight in. The repository: a local path or its
   GitHub URL (a local clone is found, or the dialog offers to clone it). A
   Jira issue arrives with its attachments, so the run starts from the key,
   not a pasted description.
3. **Runs.** The first line is the run's own worktree and branch — the agents
   work there, never in your checkout. `plan` writes a brief: acceptance
   criteria, the assumptions it made, and only the questions that block.
4. **If it asks**, the run waits on **Approvals**; your approval note is the
   answer. A small, clear ticket usually needs none.
5. **build** implements and validates the way a user would (for a web page:
   serves it, screenshots it, looks at it); QA does the same independently;
   `decide` says SHIP or FIX with a concrete list, and a FIX goes round again.
   If a step fails in a way the run cannot fix itself (a test runner that
   will not start, a push that is rejected), the run stops on **Approvals**
   with the error instead of failing: your note is guidance, and it retries.
6. **Approvals → open-pr.** Read the final decision, then approve (or request
   changes — the run goes back to implement with your note, re-checks, and
   asks again). The PR
   opens from the run's branch (as a draft listing what is left, if three
   passes were not enough). Show it on GitHub.

A clear ticket on a small repository takes about 8–10 minutes end to end.

## 2. Intake add-ons (`intake-demo`, no model calls)

Everything here happens on **Configure → Triggers**. The `intake-demo` row in
the queue list shows its idempotency window and scrub policy; the **Intake**
card at the top shows the pause switch and today's runs against its limit.

1. **Scrub before storage.** In *Test trigger*, pick `intake-demo` and send:

   ```json
   {"key":"checkout-500","title":"Checkout returns 500","severity":"high","reporter":"uid-8812","detail":"reported by jane@example.com, call +1 415 555 0100","cookie":"session=abc"}
   ```

   with `Idempotency-Key: k1`. Open the run: its input has the email and
   phone redacted, the reporter hashed, and the `cookie` field gone — that is
   what was stored, not just what is displayed.
2. **Approval ping.** The run stops at `approve-ticket`; the inbox shows
   *Approval needed …* the moment it does.
3. **Duplicate suppressed.** Send the same body with the same key again: the
   response is `"duplicate": true` and no run starts.
4. **One run per key.** Send a different body for the same `"key"` (no
   Idempotency-Key): it is skipped, because a run for `checkout-500` is
   already waiting. The **Deliveries** page shows why.
5. **Approve** it on **Approvals**: the inbox shows ticket `DEMO-1`, filed by
   an `http` step with the scrubbed fields.
6. **Low severity** (`"severity":"low"`) takes the other branch: recorded, no
   ticket, no approval needed.
7. **Pause.** Click **Pause** on the Intake card, send another event: the
   delivery is *held*, nothing runs, nothing is lost. Click **Resume**: it
   runs straight away.

## 3. Worktrees and artifacts (`worktree-test-demo`, no model calls)

1. **Pipelines → worktree-test-demo → Run**, with the path `setup.sh`
   printed as `repo`.
2. The run checks out its own worktree, runs `node --test` there (allowed by
   `SAMMY_CODE_RUN_ALLOW`, executed without a shell), and the tests fail — on
   purpose.
3. On the run page, **Artifacts → test-log → View** shows the full log, kept
   even though the step failed. The run waits at `review-log`; the inbox has
   the approval ping.
4. Approve: `attach-log` uploads the log as a file — the inbox shows
   `DEMO-1 ← test-log.txt`. The worktree is removed afterwards; the sample
   repository is untouched.

## Between takes

- Restart `sink.mjs` to clear the inbox.
- Cancel leftover paused runs on **Approvals** (or **Runs → Select → Stop**).
- An Idempotency-Key is suppressed for 120 s on `intake-demo` — use a new key,
  or wait.
- `./demo/setup.sh /some/new/path` for a fresh sample repository.
- A finished `ticket-to-pr` run removes its worktree but keeps its branch
  (it has commits). Delete it with `git branch -D sammy/…` when you are done.
- Long commit SHAs (40 hex characters) read as possible tokens to the output
  scrubber and show as `[REDACTED]`; the PR link is unaffected.
