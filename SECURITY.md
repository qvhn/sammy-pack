# Security policy

## Reporting a vulnerability

Report privately via [GitHub Security Advisories][advisory] — that keeps the
report and the fix private until a release is ready. If you would rather use
email, `quocvinh.hnguyen@gmail.com` reaches the maintainer.

Please include a reproduction: an orchestration JSON, the request or trigger
that provokes it, and what you expected instead. A proof-of-concept is welcome
but not required.

This is a single-maintainer project, so there is no response-time guarantee.
Expect acknowledgement within about a week.

[advisory]: https://github.com/qvhn/sammy-pack/security/advisories/new

## Supported versions

Pre-1.0: only the latest release of each package receives fixes. There are no
backports.

## What this project's threat model actually is

sammy-pack runs agents that execute code and call external services, so it is
worth being precise about which boundaries are meant to hold.

**Boundaries that are meant to hold — report breaks in these:**

- **Trigger signature verification.** A `signed` trigger must reject anything
  without a valid signature, before any run starts. The native
  `X-Sammy-Signature` scheme and the supported provider schemes HMAC the raw
  request bytes — except `gitlab`, which is a shared-token comparison (see
  the non-boundaries below). Forging a signature, bypassing the check, or
  getting a rejected request to queue work anyway is a vulnerability.
- **Secret handling.** Credentials live in the server environment or the
  connections store, never in committed orchestration JSON. Values are
  redacted from run events, the SSE stream, exported traces and the UI
  (`scrubEvent` at every append and relay seam, covering the explicit env
  list, every env var whose *name* looks like a secret, and the connection
  values injected into a run — `${connections:<name>.value}`, every
  `env.*` / `cache.*` / `headers.*` ref, and a `fields.<key>` ref whose key
  reads as a secret through the same name vocabulary the masker uses — or
  whose VALUE carries a credential whatever the key is called: a URL with
  userinfo, or an argv element that names its own secret, the two shapes the
  pattern pass cannot recognise), and
  the credential / MCP-registry APIs return masked values (`value`, `env.*`,
  `cache` tokens, `headers.*`, and any `fields.*` whose key or value looks
  like a secret — so a `siteUrl` or other `fields` URL long enough to look
  token-shaped comes back masked too, which costs a re-type rather than
  leaking). The mask is a defined
  shape, not a courtesy: a value under 16 characters masks to a fixed
  eight-dot placeholder (never to an empty string); a longer one reveals at
  most a quarter of itself, capped at the first 6 and last 2 characters
  (`ATATT3…28`), so a 16–31 character value shows 2–5 + 2 and only a 32+
  character provider token keeps the full recognisable prefix. Echoing any
  mask back on `PUT` restores the stored value (the pre-quarter-rule 6+2
  shape is still recognised, so a client that loaded before an upgrade
  cannot write a mask into the file). The MCP registry is masked by *value
  shape* as well as by key name, through the one predicate the store and the
  log scrubber share: a URL carrying userinfo (a token in the username slot
  counts), a value the scrubber's token patterns would redact, and a
  positional `argv` secret — `--token=…` masks itself, a bare `--token` /
  `--password` / `--key`-style flag masks the element after it — all go out
  masked; only a filesystem path or an `@scope/package` spec is exempt from
  the by-shape rule, not any value containing a `/`. A credential
  appearing in a run event, the stream, an exported trace, or an API response
  is a vulnerability. **There is no log-scrubbing layer**: `console.*` output
  is not passed through the scrubber, so a secret in stdout/stderr is a known
  limitation rather than a report — keep the process output private.
- **Owner scoping — but only with reads gated AND a verifier.** The per-run
  REST routes, the A2A task methods, the deliveries list / stats / replay,
  the concurrency view, the agent-queue view and the credential store's
  `owners` all compare the caller's resolved owner against the resource's,
  and a mismatch answers 404 (A2A: `-32001`). A credential entry that names
  no `owners` has no resource owner to mismatch and is visible to every
  reader — see the credential bullet under the hardening notes.
  **This is only a security boundary when both
  `SAMMY_REQUIRE_AUTH_READS=1` and a JWT verifier are configured**: without
  the first an unauthenticated caller chooses `X-Sammy-User` at will, and
  without the second an authenticated one does — the header is
  client-supplied until a verified claim overwrites it. Without both, owner
  scoping is a UI convenience, not a control — treat it that way. With both,
  a caller reading or mutating another owner's runs, tasks, deliveries,
  queued fires, credentials or approvals is a vulnerability.
- **Path handling.** Orchestration, agent and workspace NAMES are sanitised
  (`[a-zA-Z0-9_-]+` everywhere), and filesystem imports are confined to the
  workspace plus any root listed in `SAMMY_IMPORT_ROOTS` — resolved with
  `realpath` first, so a symlink inside an allowed root that points outside it
  is refused. Reading or writing a file outside those roots is a
  vulnerability.
- **The admin surface.** When `SAMMY_API_TOKEN` or JWT verification is
  configured, unauthenticated access to a protected *mutating* route is a
  vulnerability. The two **compose**: a bearer is accepted when it is the
  static token *or* a JWT the verifier accepts — a token caller's identity is
  the `X-Sammy-User` header it sent (the token identifies nobody; every
  holder is one shared admin), a JWT caller's is the verified claim, and any
  other bearer is refused with the verifier's reason. The static token is
  compared in constant time (both sides hashed, `timingSafeEqual`). Reads
  are open unless `SAMMY_REQUIRE_AUTH_READS` is on. Its grammar is
  `envFlag`'s, stated here exactly because this line is what decides whether
  a given deployment is gated at all: `1` / `true` / `yes` / `on` are ON and
  `0` / `false` / `no` / `off` are OFF (both trimmed and case-insensitive);
  unset or the empty string is OFF, silently; any *other* present value — a
  whitespace-only one included — warns once at `[config]` and fails
  **closed** to ON. So `SAMMY_REQUIRE_AUTH_READS=false` in a compose file or
  a manifest is a deliberate OFF and reads are wide open there; only an
  unrecognised value errs towards gating. The boot banner's `auth:` line is
  what catches it either way.
  With the flag on, every read is gated — the SSE stream included (it carries
  `?token=` / `?owner=`, lifted into the headers so the same gate verifies
  them; there is no second verifier to bypass), the root `/metrics` (unless
  `SAMMY_METRICS_PUBLIC` is on) and the root A2A discovery card
  `/.well-known/agent-card.json` (the same two gate functions, no public
  opt-out — the card enumerates every orchestration's name and description,
  and the outbound A2A client sends no credential anyway). Every gate
  classifies one canonical path (`gatePath`), not the raw request target: an
  absolute-form target (`GET http://host/api/runs`) has its
  `scheme://authority` dropped exactly as connect drops it, a `#`/`?` tail is
  cut, repeated slashes collapse, and the classifiers themselves are
  case-insensitive because connect matches a mount that way. So
  `/API/TRIGGERS/<hook>`, `/api//runs` and the absolute form are all judged as
  the canonical spelling rather than slipping past a classifier as a plain
  "read". It deliberately does **not** resolve a `.` or `..` segment: those
  SHORTEN a path, connect's mount matching resolves neither, and resolving
  them here would let `/api/<resource>/../health-check` claim the `/health`
  probe exemption while the resource's own handler answered it — a working
  anonymous read under gated reads, which is why the rule is string-only.
  Only `/livez`, `/readyz` and `/health` stay open, and they strip any
  identity header; a path that merely *contains* one of those names is not one
  of them. The two resources mounted outside `/api` — the root `/metrics` and
  the root A2A card — enforce their own exact path in the handler and answer
  404 to any remainder, because connect strips a mount by length and
  `<card>/livez` reached the reused `/api` gates as their own probe exemption.
  A gated read answered without a valid token or JWT is a vulnerability.
- **Cross-site writes.** State-changing requests are refused when the browser
  reports `Sec-Fetch-Site: cross-site`, and a request carrying a body must be
  `Content-Type: application/json` (which a cross-site form cannot set without
  a preflight). A trigger *fire* counts as state-changing whatever its
  method, so a GET-method webhook reached from a cross-site `<img src>` or a
  prefetch is refused too. Trigger ingress (`/api/triggers`, `/events`,
  `/deploy`, `/queue`) is exempt from the content-type rule only — external
  senders post whatever their provider sends — but the `Sec-Fetch-Site:
  cross-site` refusal runs first and applies there too, on the same canonical
  path every other gate classifies (see the admin-surface bullet above:
  case, repeated slashes and an absolute-form target are all the canonical
  spelling; `.` / `..` are deliberately not resolved). Reaching a mutating
  route, or firing a trigger, from another origin is a vulnerability.
- **Trigger ingress and the role gate.** Ingress is not a user session: an
  anonymous fire is judged by its HMAC (`signed`), not by a role, and with
  `SAMMY_REQUIRE_SIGNED_TRIGGERS` on an unsigned HTTP-fired trigger is refused
  before its body is read. Ingress is exempt from the *requirement* to
  authenticate, not from identity: whenever a token or a verifier is
  configured, a fire that carries neither the api token nor a verifiable JWT
  has its `X-Sammy-User` stripped and runs as `system` — it cannot name an
  owner, resolve that owner's credentials or spend their per-owner cap. (In
  the fully open posture — no token, no verifier — the header is trusted on
  ingress as it is everywhere else; there is no gate to strip it in.) A
  request that *does* carry an identity resolving to `read` is refused on any
  fire path (GET-method webhooks included), because firing starts a run;
  named-trigger routes answer 405 to a non-POST. A signed trigger firing
  without a valid signature, an unsigned trigger firing under
  `SAMMY_REQUIRE_SIGNED_TRIGGERS`, a `read` identity starting a run through
  ingress, or an unauthenticated fire running as a self-declared owner under a
  token or verifier posture is a vulnerability.

- **Role enforcement (read / write).** With `SAMMY_REQUIRE_AUTH_READS=1` and a
  JWT verifier configured, an identity holding the `read` role performing any
  mutation — or firing a trigger — is a vulnerability. Without those, roles
  are an accident guardrail rather than a control — see `docs/deployment.md`.

**Deliberately NOT boundaries — please do not report these as vulnerabilities:**

- **Agents inherit the server environment.** Agent and `code.run` subprocesses
  receive the full server env — provider keys, `DATABASE_URL`, the admin token.
  An agent reading them is the intended capability, not an escape: **the
  operator assumes the risk for any connection data they give the platform.**
  Give the server only credentials you are willing for an orchestration to
  use. (Their *values* are redacted from run events, traces and the UI, so a
  leak into the durable log IS a vulnerability — that part is a boundary.)
- **Trigger ingress is anonymous by design.** A webhook sender has no
  session; its credential is the signature, and an anonymous fire runs as
  `system`. An un-`signed` trigger accepts any sender — that is the author's
  choice, made loud by the boot banner and removable with
  `SAMMY_REQUIRE_SIGNED_TRIGGERS=1`.
- **`/api/llm/stream` with tools enabled runs them in the server process.**
  The Playground route is bounded by operator policy — the
  `SAMMY_LLM_STREAM_PERMISSION_MODE` ceiling, the allowlist and `off` — not
  by the sandbox decorator. `off` is the text-only posture: a tool-bearing
  request — `tools`, a tool-bearing subagent, or any registry MCP server
  named in `mcp` — is refused with 403 naming the lever, and the SDK's
  built-in toolset is pinned to `[]` for the rest, so a plain request cannot
  reach Read / Glob / Grep. (One known gap: a request naming registry `hooks`
  is not refused by `off`.) Anything an operator allows *above* `off` is the
  feature, not an escape.
- **The SSE stream carries its credential in the query string.** An
  `EventSource` cannot set headers, so `GET /api/runs/:id/events` accepts
  `?token=` / `?owner=`. That bearer reaches whatever logs request lines (a
  proxy or load balancer access log). It is a documented trade-off, not a
  report — see the hardening note below for the mitigations.
- **`POST /api/credentials/test` probes a caller-chosen destination when the
  caller supplies the secret.** "Test connection" needs a reachable
  endpoint, so the route fetches it from the server's network position. It is
  owner-scoped (it cannot address an entry the caller may not see) and needs
  a write-role identity — an actor this document already treats as holding
  shell access on the host, so an outbound GET grants it nothing new. Its
  one rule is the DESTINATION RULE: a request that keeps the **stored**
  secret may not also choose the destination (`urlOverride` /
  `fieldsOverride` are refused unless `valueOverride` supplies the caller's
  own secret). Note the asymmetry with the A2A push URL, which *is* host-
  allowlisted (`SAMMY_NOTIFY_ALLOWED_HOSTS`, empty = refuse all): that
  default would make "Test connection" unusable, so this route is a stated
  decision rather than an oversight. Same rule, same reason, on the `github`
  run input — a stored GitHub PAT is only ever sent to `api.github.com`, and
  only to the endpoint shape that kind needs
  (`/repos/<owner>/<repo>/{issues,pulls}/<number>`). The destination is half
  the rule: letting the caller pick any path the PAT reaches is the same
  defect in a narrower frame, and because a refusal reports the upstream
  status it would also answer "does this private repo exist".

- **`code.run` executes shell commands by design.** It is off unless
  `SAMMY_ALLOW_CODE_RUN=1`, and the boot banner says so. An orchestration that
  runs arbitrary commands is the feature, not a sandbox escape. Treat authoring
  access to orchestration JSON as equivalent to shell access on the host.
- **Agents can read and write the workspace, and call any configured tool or
  MCP server.** That is what they are for.
- **The server is not hardened for public exposure.** It binds `127.0.0.1` by
  default (`SAMMY_BIND_HOST` to change it; the container image sets
  `0.0.0.0` because a container must). Put it behind your own authentication
  and TLS if you expose it. Note that loopback binding is NOT a defence
  against requests originating in a developer's own browser — that is what the
  cross-site write guard above is for.
- **`code.source` runs in `node:vm`, which is NOT a security boundary.** The
  context is handed real host objects (run state, `vars`), and a cross-realm
  host reference is the textbook `vm` escape — so `code.source` is
  functionally equivalent to `code.run` for a *malicious* author, and
  `SAMMY_ALLOW_CODE_RUN` being unset does not make the host safe. The sandbox
  protects against accidents, not adversaries. Treat anyone who can author or
  upload orchestration JSON as holding shell access on the host.
- **`gitlab` webhook verification is a shared-token comparison, not an HMAC** —
  it proves the caller knows the token but signs nothing, so a tampered body
  still verifies. That is GitLab's design, documented in `docs/triggers.md`.
  Prefer an HMAC provider where you have the choice.

  **Composition warning:** the webhook secret is GLOBAL
  (`SAMMY_WEBHOOK_SECRET`, one value for every trigger and provider), and the
  GitLab scheme sends it in a cleartext header. So enabling one GitLab trigger
  puts the HMAC key for *every other signed trigger* on the wire, where a
  proxy log, an SIEM or a GitLab project maintainer can read it — and anyone
  who sees one delivery can then forge native-scheme signatures for all of
  them. Do not mix a GitLab trigger with other signed triggers on the same
  deployment.

## Hardening notes for operators

- Set `SAMMY_WEBHOOK_SECRET` and mark public triggers `signed`.
- Leave `SAMMY_ALLOW_CODE_RUN` unset unless you intend shell execution, and
  treat anyone who can author or upload orchestration JSON as trusted.
- Set `SAMMY_API_TOKEN` and/or JWT verification before exposing the API,
  **and set `SAMMY_REQUIRE_AUTH_READS=1`** — reads are open by default, and an
  open read means owner scoping cannot be enforced (the identity header is
  caller-supplied). The two compose, so "token for automation, JWTs for
  people" is a workable posture; but a token caller is one shared identity,
  so for multi-user a JWT verifier is required, and roles come from a claim
  only when `SAMMY_JWT_ROLE_CLAIM` names it. The boot banner's `auth:` line
  says which posture you got — `GATED IN NAME ONLY` means reads are flagged
  gated but nothing can verify a token.
- The three security flags (`SAMMY_REQUIRE_AUTH_READS`,
  `SAMMY_REQUIRE_SIGNED_TRIGGERS`, `SAMMY_METRICS_PUBLIC`) accept
  `1/true/yes/on` for ON **and** `0/false/no/off` for OFF, trimmed and
  case-insensitive; a value that is set but unrecognised warns once and the
  two `REQUIRE_*` flags then count as ON. A typo cannot silently leave a door
  open any more — it used to, when anything but `1` meant off. But
  `=0/false/no/off` is a deliberate OFF, not a typo, and is honoured in
  silence: the two sentences are not in tension, because fail-closed covers
  only values the reader does not recognise.
- Under gated reads the browser's event stream sends the token as
  `?token=` on every `EventSource` URL it opens — the Settings → User
  identity "API token" field is where the UI stores it, and the UI puts that
  stored value into the query string itself, so the field keeps the token
  out of chat and scripts but not out of a request line. The two mitigations
  are: if a reverse proxy or load balancer fronts the server, configure it to
  strip the `token` query parameter from its access logs; and prefer
  short-lived JWTs for browser sessions over the static admin token.
- Leave `SAMMY_METRICS_PUBLIC` unset unless your scraper cannot send a
  token; `/metrics` lists run counts per orchestration.
- Set `SAMMY_REQUIRE_SIGNED_TRIGGERS=1` on any deployment whose ingress is
  reachable from outside, so an author cannot ship an unsigned trigger by
  accident.
- `SAMMY_NOTIFY_ALLOWED_HOSTS` is empty by default, which disables A2A push
  notifications; name only hosts you own before enabling them (the server
  POSTs run data there). It shares one list grammar (comma / semicolon /
  whitespace) with `SAMMY_READONLY_USERS` and
  `SAMMY_LLM_STREAM_TOOL_ALLOWLIST`.
- `SAMMY_LLM_STREAM_TOOLS=off` and `SAMMY_LLM_STREAM_PERMISSION_MODE` bound
  the browser Playground route, which is not sandbox-policed; `off` is
  text-only (the SDK's built-in toolset is `[]`, and a request naming `tools`,
  a tool-bearing subagent or any `mcp` server is refused), the mode is
  resolved once at boot, a caller can narrow it but never widen it, and
  subagents are held to the same allowlist and mode.
- `GET /api/credentials` returns masked secrets (the quarter rule above:
  nothing below 16 characters, at most 6+2 above) and only the entries the
  caller may see — and be precise about what that means, because the default
  is permissive: an entry that names `owners` is returned only to those
  owners, while an entry with **no** `owners` (the back-compat default for
  every entry created without naming any) is returned to every caller who
  can read, with its `kind`, `url`, `orchestrations`, its readable `fields`
  and its masked secrets. Set `owners` to restrict an entry; leaving it
  unset is not privacy. `GET /api/mcp-servers` is masked the same way but is
  **not** owner-scoped at all: the registry has no owner concept, so every
  caller who can read gets the whole registry (every server's `command`,
  `args` and `url`, secrets masked). A UI round-trip restores masks from disk
  rather than writing them, and changing an entry's `url` / `fields` /
  `owners` / `orchestrations` while any of its secrets (`value`, `env`,
  `headers`, `cache`, secret-looking `fields`) is masked is refused — on
  `PUT /api/credentials` and on the batch `POST /api/credentials/import`
  alike, so a credential cannot be re-pointed without re-supplying it
  through either writer. The Connections editor applies that rule before the
  request: moving a destination field while a secret is still the server's
  mask clears the `value` input, marks it required with an inline hint
  naming the moved field (or names the masked `env` / `headers` / `cache` /
  `fields` block, putting the hint on the offending `fields` input when the
  kind declares a control for that key and pointing at the raw-JSON editor
  when it does not), and disables Save until a secret is typed.
- Keep `SAMMY_BIND_HOST` at its `127.0.0.1` default unless something in front
  of the server terminates auth and TLS.
- `SAMMY_IMPORT_ROOTS` is the allowlist for filesystem imports. Leave it unset
  unless you genuinely import agents or orchestrations from another tree; an
  import's symlink is read back over the API and written through on edit, so
  an allowed root is a root the API can read and write.
- `SAMMY_MAX_BODY_BYTES` and `SAMMY_MAX_QUEUE_DEPTH` bound an unauthenticated
  caller's memory and queue impact. See the reliability knobs in
  `docs/triggers.md`.
