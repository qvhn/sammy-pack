export type SchemaRef = string | Record<string, unknown>;

/**
 * Canonical LLM provider list — the SINGLE source of truth.
 *
 * The provider set used to be hand-copied into four places (this type, the
 * `ALL_PROVIDERS` array + `ProviderId` in providers.ts, the `allowed` list in
 * validate.ts, and the schema enum) — which is exactly how `bedrock` once
 * shipped runnable but missing from the published schema. Now everything
 * derives from here: `providers.ts` and `validate.ts` import `ALL_PROVIDERS`,
 * `Node.provider` is typed `ProviderId`, and `__tests__/schema-parity.test.ts`
 * asserts the schema enum equals `ALL_PROVIDERS`. Add a provider in one place
 * and the type guard below + that test force the rest to follow.
 */
export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'claude-code'
  | 'bedrock';

export const ALL_PROVIDERS = [
  'anthropic',
  'openai',
  'gemini',
  'claude-code',
  'bedrock',
] as const satisfies readonly ProviderId[];

// Compile-time exhaustiveness: `satisfies` above rejects an extra/misspelled
// entry; this rejects a MISSING one — add a ProviderId without listing it in
// ALL_PROVIDERS and the build fails here.
type _MissingProvider = Exclude<ProviderId, (typeof ALL_PROVIDERS)[number]>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _allProvidersExhaustive: _MissingProvider extends never
  ? true
  : {
      readonly ERROR: 'ALL_PROVIDERS is missing a ProviderId';
      readonly missing: _MissingProvider;
    } = true;

export type Workspace = {
  name: string;
  description?: string;
  connection: string;
  repo?: string;
  ref?: string;
  paths?: Record<string, string>;
};

/** Refinement loop. Body runs up to `maxIterations` times. Each iteration's
 * output becomes the next iteration's input.
 *
 * Stop conditions (any one triggers loop exit):
 *  - `maxIterations` reached
 *  - `until` matches: body output contains this string (case-insensitive)
 *  - `whileOutput` STOPS matching: stay in the loop only while output contains
 *    this string; exit as soon as it doesn't
 *  - `judge` agent: after each iteration, the judge sees the body's output and
 *    emits "STOP" (case-insensitive) to end the loop, anything else to continue
 *
 * Failure handling:
 *  - `retryOnFailure: true` — if any phase in the body errors, treat the body
 *    output as the error, retry up to `maxIterations`. Without this, an error
 *    inside the body propagates and ends the run.
 *  - `maxFailures` — a hard cap on CONSECUTIVE failing iterations under
 *    `retryOnFailure`. The classic retry-storm: every iteration fails its
 *    `validate` step, so a `retryOnFailure` loop grinds the full
 *    `maxIterations` re-doing fine work because it can't tell a broken
 *    validator from a wrong fix. With `maxFailures: N` the loop gives up after
 *    N consecutive failures (emitting `loop-exhausted`) instead of burning
 *    every iteration. Only meaningful with `retryOnFailure`; unset = no extra
 *    cap (today's behavior — `maxIterations` is the only bound). A
 *    terminal-marked failure (see {@link OnFailurePolicy}) short-circuits this
 *    immediately regardless of the count.
 */
export type LoopBody = {
  body: Node;
  maxIterations: number;
  until?: string;
  whileOutput?: string;
  judge?: string;
  /** When set, the judge replies with a numeric score and the loop
   *  exits as soon as `score >= stopAtScore`. A literal STOP still
   *  forces exit at any score, so this composes with the existing
   *  STOP / CONTINUE protocol. Useful for quality-gated refinement. */
  stopAtScore?: number;
  retryOnFailure?: boolean;
  /** Hard cap on CONSECUTIVE failing iterations when `retryOnFailure` is set.
   *  After this many back-to-back failures the loop stops (emits
   *  `loop-exhausted`) instead of grinding through every `maxIterations`. The
   *  bound that kills a validate-fails-every-time retry storm. A successful
   *  iteration resets the count; a terminal-marked failure stops immediately.
   *  Must be >= 1; unset = unbounded (only `maxIterations` bounds the loop, as
   *  before). Ignored without `retryOnFailure`. */
  maxFailures?: number;
  /** Default true. Frame each re-iteration as a refinement of existing work
   *  so the worker builds on prior output instead of cold-starting and
   *  re-deriving context every round. `false` = legacy raw passthrough. */
  carryContext?: boolean;
  /** Default false. Carry the full prior-iteration history forward each round
   *  so the worker keeps complete context (stronger than `carryContext`, but
   *  context grows). Stateless / durability-safe; opt-in for tight loops. */
  warmSession?: boolean;
};

/** Alternating-turn conversation. Each turn the next participant sees the full
 * transcript and produces their reply. After `rounds` turns the conversation ends
 * and the transcript is the output. */
export type ConversationBody = {
  /** Agent paths, cycled in order. */
  participants: string[];
  rounds: number;
};

/** Conditional routing. If a `router` agent is set, it classifies the input and
 * picks a branch by name. Otherwise the input is substring-matched (case-insensitive)
 * against branch keys. `default` is used when no branch matches. */
export type RouteBody = {
  router?: string;
  branches: Record<string, Node>;
  default?: Node;
};

/** Deterministic value-based branching — a switch / case (and if-else, via
 *  `true`/`false` cases). Unlike `route` (which can use an LLM router to
 *  CLASSIFY free text), `switch` matches the resolved value of `on` EXACTLY
 *  against case keys, so a preceding script or agent that emits a discrete
 *  value (`true`/`false`, `x`/`y`/`z`, a status code) deterministically
 *  selects a case. Matching normalizes both sides (trim, strip wrapping
 *  quotes, case-insensitive) and also understands a structured
 *  `{"case":"x"}` verdict or a value printed on the last line. `default`
 *  runs when nothing matches. */
export type SwitchBody = {
  /** Expression to switch on, interpolated over run state + scope (e.g.
   *  "${verdict}"). Defaults to the upstream phase output when unset. */
  on?: string;
  /** value → branch. The first case whose normalized key equals the
   *  normalized value runs. `true`/`false` keys give a plain if-else. */
  cases: Record<string, Node>;
  /** Fallback when the value matches no case. Without it, an unmatched
   *  value fails the phase (keeps the switch total and explicit). */
  default?: Node;
};

/** Fan-out over an array. `over` resolves to an array from state (or is parsed
 * as JSON if it's a string). `body` runs once per item with `${item}` and
 * `${index}` available in interpolation. Outputs are joined as the map's
 * pipeline output and (if `as` is set) stored as a true array in state. */
export type MapBody = {
  /** Either `${name}` of a state var holding an array (or a JSON-encoded array
   *  string), or an inline JSON array literal. */
  over: string;
  body: Node;
  /** Run items serially instead of all-at-once. Default false (parallel). */
  serial?: boolean;
  /** Cap how many items run concurrently in the parallel path (e.g. 3 to bound
   *  fan-out to a pool of 3 simulators / GPUs / rate-limited sessions). Items
   *  run in batches of this size. Unset = all-at-once. Ignored when serial. */
  concurrency?: number;
};

/** How a signed trigger's firing request is authenticated.
 *
 *  `true` — sammy-pack's own scheme: `X-Sammy-Signature`, either the
 *  replay-protected `t=<unix>,n=<nonce>,v1=<hex HMAC-SHA256 of "t.n.body">`
 *  or the legacy `sha256=<hex HMAC-SHA256 of body>`. Use this for callers you
 *  control (your own services, the queue-source adapters).
 *
 *  A PROVIDER NAME — verify that third party's own scheme instead, because no
 *  external provider will ever send `X-Sammy-Signature`:
 *    - `"github"`            X-Hub-Signature-256 (also Bitbucket, Jira, Gitea)
 *    - `"stripe"`            Stripe-Signature, timestamped
 *    - `"slack"`             X-Slack-Signature + X-Slack-Request-Timestamp
 *    - `"shopify"`           X-Shopify-Hmac-Sha256 (base64)
 *    - `"linear"`            Linear-Signature
 *    - `"standard-webhooks"` the standardwebhooks.com spec (Svix, Resend,
 *                            Clerk, Brex)
 *    - `"gitlab"`            X-Gitlab-Token — a shared token, NOT an HMAC: it
 *                            proves the caller knows the secret but signs
 *                            nothing, so a tampered body still verifies.
 *                            Prefer an HMAC provider where you have a choice.
 *
 *  Either way the secret is the server's SAMMY_WEBHOOK_SECRET, so no secret
 *  is ever committed in orchestration JSON. Unsigned or mismatched requests
 *  are rejected 401 before any run starts. See
 *  `src/server/provider-signatures.ts`. */
export const WEBHOOK_PROVIDER_NAMES = [
  'github',
  'stripe',
  'slack',
  'shopify',
  'linear',
  'gitlab',
  'standard-webhooks',
] as const;

export type WebhookProviderName = (typeof WEBHOOK_PROVIDER_NAMES)[number];

export type TriggerSignature = boolean | WebhookProviderName;

/** Ingress options shared by the HTTP-fired triggers (webhook / events /
 *  deployment / queue) — they shape how an inbound fire is RECORDED, before
 *  any run exists. */
export type TriggerIntakeOptions = {
  /** How long an `Idempotency-Key` header suppresses a repeat, in seconds.
   *  Unset = forever (the key is consumed once per orchestration for good).
   *  With a window, a sender may legitimately re-raise the same key later —
   *  e.g. one triage per error group per day without bucketing the date into
   *  the key. Sliding: measured from the most recent accepted fire. */
  idempotencyTtlSeconds?: number;
  /** Scrub the payload BEFORE it is stored or reaches a run — PII detectors,
   *  custom patterns, field allow/drop lists and salted hashing. See
   *  `server/payload-scrub.ts`. */
  scrub?: import('./intake-options').ScrubPolicy;
};

/** Webhook trigger — POST (or GET) /api/triggers/<path> starts a run
 * with the request body as initial input. */
export type WebhookTrigger = TriggerIntakeOptions & {
  kind: 'webhook';
  path: string;
  method?: 'GET' | 'POST';
  /** Require a signature on the request (P4). See `TriggerSignature`:
   *  `true` for sammy-pack's own scheme, or a provider name (`"github"`,
   *  `"stripe"`, …) to verify that provider's scheme instead. */
  signed?: TriggerSignature;
};

/** Cron trigger — fires on the given cron expression (5-field, server
 * time). Initial input is the firing time (ISO string). */
export type CronTrigger = {
  kind: 'cron';
  expr: string;
  /** What to do when this cron's PREVIOUS run is still in flight when the
   *  next tick arrives. Default `"skip"`.
   *
   *    "skip"  — drop this tick; the running one continues. Right for almost
   *              every scheduled job.
   *    "queue" — park this tick and run it when the previous finishes.
   *              Bounded work, but a persistently slow run builds a backlog.
   *    "allow" — no guard: overlapping runs of the same schedule. A
   *              `* * * * *` cron on a ten-minute orchestration accumulates
   *              ~10 concurrent runs, so choose this only deliberately.
   *
   *  An explicit root-level `concurrency` block takes precedence. */
  overlap?: 'skip' | 'queue' | 'allow';
  /** IANA timezone the expression is evaluated in, e.g. `"America/New_York"`.
   *  Defaults to the SERVER's local zone, which is fine for a single-region
   *  deployment and a trap for anything else — `"0 9 * * *"` then means a
   *  different moment depending on where the process happens to run. It also
   *  scopes the fire's dedupe bucket, so a DST fall-back (when the local hour
   *  occurs twice) fires ONCE rather than twice. */
  timezone?: string;
};

// ── Additional trigger kinds ─────────────────────────────────────────────
// All fire on the dev server. events/deployment/queue are named HTTP-fired
// triggers (POST /api/<ns>/<name>); polling runs on a server-side interval.

/** Event trigger — starts a run when a named domain event is published.
 *  Fire it with POST /api/events/<event>; the request body becomes the run's
 *  initial input. Multiple orchestrations may subscribe to one event. */
export type EventsTrigger = TriggerIntakeOptions & {
  kind: 'events';
  /** Event name to subscribe to, e.g. "user.created" or "pr.opened". */
  event: string;
  /** Require a signature on the firing HTTP request (see
   *  `TriggerSignature`). If ANY subscriber to this event sets it, the
   *  endpoint requires a valid signature (strictest wins); subscribers that
   *  name DIFFERENT providers are a conflict the ingress refuses, since no
   *  one request could satisfy both. Internal chain events (`<orch>.done`)
   *  are unaffected. */
  signed?: TriggerSignature;
};

/** Deployment trigger — starts a run when an environment is deployed,
 *  e.g. staging deployed → QA orchestration. Fire it with
 *  POST /api/deploy/<environment>; the request body is the initial input. */
export type DeploymentTrigger = TriggerIntakeOptions & {
  kind: 'deployment';
  /** Environment whose deploy fires this, e.g. "staging" or "prod". */
  environment: string;
  /** Require a signature on the firing HTTP request (see
   *  `TriggerSignature`). Strictest-wins across subscribers. */
  signed?: TriggerSignature;
};

/** Polling trigger — the server periodically fetches `source` and starts a
 *  run whenever the response body is non-empty and has changed since the
 *  previous tick (the body becomes the initial input). */
export type PollingTrigger = {
  kind: 'polling';
  /** URL to poll. */
  source: string;
  /** Poll interval in seconds. */
  intervalSeconds: number;
};

/** Queue trigger — each delivered message starts a run with the message body
 *  as initial input. Deliver a message with POST /api/queue/<queue>. */
export type QueueTrigger = TriggerIntakeOptions & {
  kind: 'queue';
  /** Queue name to consume from. */
  queue: string;
  /** Require a signature on the delivering HTTP request (see
   *  `TriggerSignature`). Strictest-wins across subscribers. */
  signed?: TriggerSignature;
};

export type Trigger =
  | WebhookTrigger
  | CronTrigger
  | EventsTrigger
  | DeploymentTrigger
  | PollingTrigger
  | QueueTrigger;

/** Trigger kinds the server actually fires. All six have executors in
 *  `sammy-pack-api.ts` (webhook/events/deployment/queue are HTTP-fired,
 *  cron/polling run on a server-side schedule). */
export const LIVE_TRIGGER_KINDS: ReadonlySet<Trigger['kind']> = new Set([
  'webhook',
  'cron',
  'events',
  'deployment',
  'polling',
  'queue',
]);

/** Deployment lifecycle. `stage` (dev → staging → prod) reflects readiness;
 * `deprecated` marks the orchestration as obsolete (still runnable, but
 * the executor emits a warning event + A2A discovery hides it). */
export type Lifecycle = {
  stage?: 'dev' | 'staging' | 'prod';
  /** Free-form discovery tags (e.g. "delivery", "qa", "starter"). Drive the
   *  tag filter on the Pipelines page; purely descriptive — no runtime
   *  effect. */
  tags?: string[];
  deprecated?: boolean;
  deprecationReason?: string;
  /** Name of an orchestration to run after THIS one finishes with
   *  status='error'. Receives a JSON envelope `{ failedRunId, error,
   *  lastOutput }` as its initial input. Composes with — does not
   *  replace — the per-node `onError` decorator. The error
   *  orchestration's own failures do NOT cascade. */
  errorOrchestration?: string;
};

/** Inline JS transform. Runs a snippet against the upstream output
 * and uses its return value as the next phase's input. For
 * deterministic reshaping between agents — parse JSON, filter,
 * slice — without an LLM call. */
/** A typed run input the orchestration accepts (a ticket, doc, URL, file).
 *  Resolved to text content and seeded as `${name}` before phase 1. */
export type InputDecl = {
  name: string;
  kind: 'text' | 'url' | 'jira' | 'confluence' | 'github' | 'file';
  required?: boolean;
  description?: string;
};

export type CodeBody = {
  /** Inline JS transform (mutually exclusive with `run`). Runs in a `vm`
   *  sandbox with NO ambient I/O — no `require` / `process` / `fetch` /
   *  network / fs; only `input` / `state` / `item` / `index` / `vars` and
   *  the JS built-ins (JSON, Math, Date, …) are in scope. `return` a value
   *  (objects are JSON-stringified). CPU is bounded by `sandbox.maxRunSeconds`
   *  (a vm watchdog interrupts synchronous loops a phase `timeout` cannot)
   *  and output by `sandbox.maxOutputBytes`. A pure deterministic transform —
   *  not a security boundary against a malicious author (that's OS isolation). */
  source?: string;
  /** Legacy external shell command. DISABLED by default — runs arbitrary host
   *  commands via `spawn(shell)`. Set `SAMMY_ALLOW_CODE_RUN=1` to enable.
   *  Prefer an agent with the Bash tool, which the sandbox policy governs. */
  run?: string;
  /** With `run`: keep the command's full log (stdout, stderr, exit) as a
   *  named run artifact — retrievable at GET /api/runs/:id/artifacts/<name>
   *  — on failure as well as success. Bounded to its tail
   *  (SAMMY_ARTIFACT_MAX_BYTES, default 256 KiB) and scrubbed. */
  artifact?: string;
  /** With `run`: the working directory — interpolated (`${worktrees.app.path}`,
   *  or a path relative to the run's single worktree) and required to lie
   *  INSIDE one of the run's root `worktrees`. For runs that declare several
   *  worktrees, where there is no default. */
  cwd?: string;
};

/** Outbound A2A call. Dispatches a phase to a remote agent that speaks
 * the A2A (Agent2Agent) protocol — the executor fetches the agent card,
 * submits the upstream output as an A2A task, polls to completion, and
 * folds the result artifact in as this phase's output. */
export type A2aBody = {
  /** URL of the remote agent's A2A agent card. */
  agentCard: string;
  /** Optional skill id from the remote card to invoke. */
  skill?: string;
};

/** Retry policy. Runs *before* onError — only if all retries exhausted does
 * onError fire. Composes with timeout: each attempt gets its own timeout. */
export type RetryPolicy = {
  times: number;
  backoff?: 'fixed' | 'exponential';
  /** Delay before second attempt; doubled each time if exponential. */
  initialMs?: number;
};

/** Stall → recovery policy. When the stall watchdog aborts a node for making
 *  no progress (StallError), instead of letting the stall flow straight to
 *  abort, run a `recover` phase in the node's context and then RE-RUN the
 *  stalled node — up to `maxRetries` times. The classic use: a node wedged on a
 *  stuck external dependency (a hung sim, a dead headless browser) where a
 *  targeted fix-up (kill + relaunch the dependency) lets a re-run succeed. The
 *  `recover` body is a normal phase (code / agent / prompt). When unset, a stall
 *  flows through retry / onError exactly as before. */
export type OnStallPolicy = {
  /** Recovery phase run when the node stalls — a normal node body
   *  (code / agent / prompt). `${error.message}` (the stall message) is
   *  available inside it, like an `onError` branch. Its output is NOT used as
   *  the node's output; it runs purely for its side effect, after which the
   *  ORIGINAL node is re-run. */
  recover: Node;
  /** How many times to recover-and-re-run before giving up and aborting the
   *  run with the stall. Default 1 (recover once, re-run once). 0 disables
   *  recovery (a stall aborts immediately — same as no `onStall`). Must be
   *  >= 0. */
  maxRetries?: number;
};

/** Per-node circuit breaker. Checked before and after each agent call inside
 * this node's subtree. Crossing the limit aborts the run with BudgetExceededError. */
export type Budget = {
  maxTokens?: number;
  maxCostUsd?: number;
};

/** Execution-safety policy. A node's effective sandbox is its own merged
 * with every ancestor's — children may only TIGHTEN, never widen:
 * tool allowlists intersect, command denylists union, the stricter
 * permissionMode wins. */
export type Sandbox = {
  /** Allowlist of Claude Code built-in tools. An agent's declared
   *  tools[] are intersected with this; anything not listed is stripped
   *  before dispatch. Omit for no cap. */
  allowedTools?: string[];
  /** Case-insensitive substrings that abort the phase if found in a
   *  Bash command. Blast-radius limits — "rm -rf", "sudo", "curl | sh". */
  deniedCommands?: string[];
  /** When false, network tools (WebFetch / WebSearch) are stripped.
   *  Default true. */
  networkAccess?: boolean;
  /** SDK permission-mode floor for the subtree. The stricter of this
   *  and the node's own permissionMode wins. */
  permissionMode?: 'bypassPermissions' | 'acceptEdits' | 'plan' | 'default';
  /** Wall-clock cap for a `code` node, in seconds. A vm watchdog interrupts
   *  synchronous CPU loops (which a phase `timeout` can't — they block the
   *  event loop), and a host-side race bounds async hangs. Merges to the
   *  stricter (smaller) value. Default 5. */
  maxRunSeconds?: number;
  /** Cap on a `code` node's output, in bytes; larger output fails the phase.
   *  Merges to the stricter (smaller) value. Default 1 MiB. */
  maxOutputBytes?: number;
  /** Cap on a `map` node's fan-out — the number of items it expands to. The
   *  array can be LLM-determined (an upstream agent's output), so an
   *  unbounded `map` is an unbounded blast radius; over the cap fails the
   *  phase. Merges to the stricter (smaller) value. Default 1000. */
  maxFanout?: number;
};

/** Reducer semantics for a single named state slot. The executor parses
 *  each incoming `as:` write as JSON (falling back to the raw string)
 *  and combines it with the slot's current value per the reducer:
 *   - `append`      → coerce both sides to arrays, concat new onto old
 *   - `merge`       → object spread (old first, then new — new wins)
 *   - `replace`     → last-write-wins (same as undeclared keys; explicit)
 *   - `concat`      → string concat with newline separator
 *   - `increment`   → numeric add (parses both sides as Number)
 *  `initial` seeds the slot before any write — `append` defaults to
 *  `[]`, `merge` to `{}`, `increment` to `0`, others to undefined. */
export type StateDecl = {
  reducer: 'append' | 'merge' | 'replace' | 'concat' | 'increment';
  initial?: unknown;
};

/** Built-in hard wallclock cap (seconds) applied to EVERY node that sets no
 *  `timeout` of its own — the last tier of `node.timeout ?? defaults.timeout ??
 *  DEFAULT_NODE_TIMEOUT_SEC` (overridable at run time via
 *  SAMMY_DEFAULT_NODE_TIMEOUT_SEC). Defined here as the single source of truth so
 *  the executor (which enforces it) and the offline `preview` linter (which warns
 *  a composite that would silently inherit it) can't drift on the number. */
export const DEFAULT_NODE_TIMEOUT_SEC = 1800;

/** Top-level only: run-wide fallbacks for the per-node resource limits.
 *  Each field supplies the value a node uses when it does NOT set its own
 *  `timeout` / `stallTimeout` / `maxAgentTokens`, so an orchestration whose
 *  phases all want (say) a longer stall window than the built-in default can
 *  declare it ONCE here instead of repeating it on every phase. Resolution is
 *  strictly `node.X ?? defaults.X ?? <existing env / built-in default>` — a
 *  node value always wins, and leaving both unset is exactly today's behavior.
 *  Only the orchestration root node is read; the field is ignored on children. */
export type OrchestrationDefaults = {
  /** Default per-node wallclock `timeout` (seconds) when a node omits its own. */
  timeout?: number;
  /** Default per-node `stallTimeout` (seconds) when a node omits its own. */
  stallTimeout?: number;
  /** Default per-leaf `maxAgentTokens` ceiling when a node omits its own. */
  maxAgentTokens?: number;
};

/** What to do when a fire would start a run in a {@link OrchestrationConcurrency}
 *  group that already has an active (running/paused) run:
 *   - `skip`            → drop the new fire; the active run is left to finish.
 *   - `queue` (default) → park the fire on the durable pending-fire queue; it
 *                         starts automatically when the active run terminates.
 *   - `cancel-existing` → cancel every active run in the group, then start the
 *                         new one (last-fire-wins).
 *  The framework never interprets the group string — see
 *  {@link OrchestrationConcurrency}. */
export type ConcurrencyPolicy = 'skip' | 'queue' | 'cancel-existing';

/** Top-level only: declares that runs of this orchestration share an external
 *  resource and must not run concurrently with any other run in the same
 *  `group`. `group` is an OPAQUE token — the framework knows nothing about what
 *  it represents (a staging environment, a device, a rate-limited account); two
 *  orchestrations naming the same group are mutually exclusive, and that is the
 *  whole contract. `policy` decides what a fire does when the group is busy
 *  (default `'queue'`). Read only off the orchestration root; a value on a child
 *  node is ignored. Exclusion is enforced per-process today (an in-process
 *  per-group lock serializes the check-and-create); cross-process exclusion is a
 *  documented follow-up. */
export type OrchestrationConcurrency = {
  /** Opaque mutual-exclusion key. Runs sharing this string never overlap. */
  group: string;
  /** Conflict policy when the group is busy. Defaults to `'queue'`. */
  policy?: ConcurrencyPolicy;
};

/** Top-level only: per-orchestration admission limits, checked when a
 *  TRIGGER fires. Usage counts every run of the orchestration (manual starts
 *  included — they spend the same money), but only trigger fires are held
 *  back: a fire over a limit is HELD — re-queued, not dropped — until the
 *  window rolls over, and a scheduled (cron / polling) tick is skipped. Days
 *  and months are server-local, as for the workspace budget. */
export type OrchestrationLimits = {
  /** Runs this orchestration may START per day (any trigger). */
  maxRunsPerDay?: number;
  /** Spend this orchestration's runs may reach per day, USD. */
  maxCostUsdPerDay?: number;
  /** Spend this orchestration's runs may reach per month, USD. */
  maxCostUsdPerMonth?: number;
};

/** Top-level only: an isolated git worktree per run. Each entry checks a
 *  fresh worktree of a LOCAL repository out on a new branch before the run
 *  starts, exposes its path to every phase, and removes it when the run
 *  ends — so concurrent runs never share a working tree and an agent's
 *  edits never touch the checkout a person is using. */
export type WorktreeDecl = {
  /** Identifier, used in `${worktrees.<name>.path}` / `.branch` and in the
   *  `SAMMY_WORKTREE_<NAME>` env var. Letters, digits, `_`, `-`. */
  name: string;
  /** Path to a local git repository (absolute, or relative to the
   *  workspace root). */
  repo: string;
  /** Ref the branch starts from. Default: the repo's current HEAD. */
  base?: string;
  /** Branch name template; `${run.id}`, `${run.short}` (the run id's random
   *  suffix), `${orchestration}`, `${worktree.name}` and `${input.<field>}`
   *  interpolate. Default `sammy/<run.short>-<name>`. */
  branch?: string;
  /** What to do with the worktree when the run ends:
   *  `remove` (default) deletes it — and the branch, if it has no commits
   *  beyond `base` — on success, but KEEPS it on error so a person can look;
   *  `keep` never removes it; `always-remove` removes it whatever happened. */
  cleanup?: 'remove' | 'keep' | 'always-remove';
};

/** One HTTP request, no model. Interpolated like a prompt; the response body
 *  is the phase output. Hosts must be allowlisted (`allowHosts` on the node,
 *  or `SAMMY_HTTP_ALLOWED_HOSTS`). */
export type HttpBody = {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  /** Request body. A string is sent as-is; an object is JSON-encoded. */
  body?: string | Record<string, unknown> | unknown[];
  /** Hostnames this node may call, in addition to SAMMY_HTTP_ALLOWED_HOSTS. */
  allowHosts?: string[];
  /** Status codes treated as success. Default: any 2xx. */
  expectStatus?: number[];
  /** Per-request timeout, seconds. Default 30. */
  timeoutSeconds?: number;
  /** Max response bytes kept as output. Default 1 MB. */
  maxResponseBytes?: number;
  /** HTTP Basic auth, built into an `Authorization: Basic …` header (Jira
   *  Cloud and Bitbucket API tokens use it). Both values are interpolated
   *  like headers — use `${connections:<name>.<field>}`. */
  auth?: { basic: { username: string; password: string } };
  /** Send the request as multipart/form-data with these run ARTIFACTS as
   *  file parts (e.g. a `code.artifact` repro log attached to a ticket).
   *  An object `body` becomes text fields beside them. */
  files?: Array<{
    /** Form field name. Default `file`. */
    field?: string;
    /** Artifact name (as `code.artifact` named it; the iteration-scoped name
     *  is tried first, then the bare one). */
    artifact: string;
    /** Filename sent with the part. Default `<artifact>.txt`. */
    filename?: string;
  }>;
};

/** Outbound notification config (orchestration root only). Fired from the
 *  server's terminal hook when a run reaches a terminal status. A
 *  server-boundary feature — the executor itself has no notion of it. */
export type NotifyConfig = {
  /** URL to POST a small JSON envelope to when the run reaches terminal
   *  (`done` / `error` / `cancelled` / `paused`):
   *  `{ runId, orchestration, status, summary? }`. Best-effort and
   *  fire-and-forget — a slow / dead endpoint never blocks or fails the run;
   *  webhook errors are swallowed. Interpret it as an opaque sink (Slack
   *  incoming webhook, an internal collector, …). */
  onTerminal?: string;
  /** Run-level thrash / retry-storm watchdog. When a run is "thrashing" — the
   *  SAME per-item phase re-running far more than a healthy refinement would —
   *  the server emits a loud `run-divergence` event and records the verdict.
   *  Derived purely from the durable event stream at terminal time (no
   *  per-phase overhead). Omitting this uses the default: WARN at the default
   *  repeat threshold, never auto-abort. See {@link DivergenceConfig}. */
  divergence?: DivergenceConfig;
  /** URL to POST to the moment a run stops at an approval gate (`lock`) —
   *  before anyone has to notice the run is paused. The body carries
   *  `text` (so a Slack / Teams incoming webhook renders it as-is), the run
   *  id, orchestration, gate path, and a `runUrl` when `SAMMY_PUBLIC_URL` is
   *  set. Best-effort, like `onTerminal`. */
  onGate?: string;
};

/** Tuning for the run-level divergence (retry-storm) watchdog — see
 *  server/divergence.ts. Attached to the orchestration root's `notify`
 *  block. All optional; omitting it = WARN-only at the default threshold. */
export type DivergenceConfig = {
  /** Repeat count at which a single phase INSTANCE (same iteration-scoped
   *  replay key) is flagged as thrashing. A `map` over N items is NOT thrash
   *  (each item is a distinct instance seen once); only the same item's phase
   *  re-running accumulates. Default 6 (above a normal review loop, below the
   *  ~12×/item storm this guards). Clamped to a minimum of 2. */
  repeatThreshold?: number;
  /** When true, a diverged run is ABORTED mid-flight instead of merely
   *  flagged + warned. Default false (warn-only) — so enabling the watchdog
   *  never turns a previously-completing run into a failing one. */
  abort?: boolean;
};

/** Durable wait leaf — the run parks at zero cost until a timer elapses or an
 *  external signal arrives. Exactly one of `seconds` / `until` / `signal`
 *  (schema-enforced). On a server-owned run the wait snapshots + pauses like a
 *  `lock` gate: the executor emits a `wait-started` event carrying the ABSOLUTE
 *  deadline (computed once at first crossing, so restarts / early resumes never
 *  re-arm the clock), throws RunPauseRequested, and the server's wait sweeper
 *  resumes the run when due (~30s granularity) — or immediately when
 *  POST /api/runs/:id/signal delivers a matching signal. In a non-server run
 *  (no durable pause available) a timer waits in-memory; a signal wait that has
 *  no buffered delivery fails loudly rather than hanging forever. */
export type WaitBody = {
  /** Relative durable timer, seconds from FIRST crossing. */
  seconds?: number;
  /** Absolute ISO-8601 deadline (interpolated). Past deadlines complete
   *  immediately with `waited: false`. */
  until?: string;
  /** External-signal name (interpolated). The matching signal's payload
   *  becomes this phase's output; early signals are buffered FIFO. */
  signal?: string;
  /** Only with `signal`: fail the phase (normal retryable phase error) when
   *  the signal hasn't arrived after N seconds. */
  timeoutSeconds?: number;
};

/** How a run walks an orchestration. `pipeline` (the default): the engine
 *  walks the tree and gives every agent step its own agent. `harness`: ONE
 *  agent follows the tree as a list of steps and does each one itself — with
 *  the skill the step names, or by doing the step's task — while the engine
 *  runs the script / HTTP / wait steps exactly as written, holds the gates,
 *  checkpoints each finished step and decides whether the run is complete. */
export type ExecutionMode = 'pipeline' | 'harness';

/** How closely a harness run must follow the orchestration's steps.
 *   - `strict`   — in the declared order; a step can't start until the one
 *                  before it is done (steps inside a `parallel` may go in any
 *                  order among themselves). The default.
 *   - `loose`    — any order, but every required step must be done before the
 *                  run can finish.
 *   - `advisory` — the steps are a guide: the agent may skip one, saying why;
 *                  the run then ends degraded, naming what was skipped.
 *  Gates, budgets and the sandbox hold in every mode. */
export type HarnessFollow = 'strict' | 'loose' | 'advisory';

/** Top-level `harness` block: how this orchestration runs in harness mode. */
export type HarnessConfig = {
  /** Default `strict`. A run may override it (the Run dialog, the start API)
   *  unless `lockFollow` is set; otherwise the workspace default applies. */
  follow?: HarnessFollow;
  /** The run may only make `follow` STRICTER than declared here, never looser
   *  (a deploy that must go step by step). */
  lockFollow?: boolean;
  /** Model for the harness agent. Default: the run's model. */
  model?: string;
  /** Extra guidance for the harness agent, added to its system prompt. */
  instructions?: string;
  /** SDK turn cap for one harness session leg. Default 1000. */
  maxTurns?: number;
};

export type Node = {
  name: string;
  description?: string;
  /** Top-level only: semver of this orchestration DEFINITION. Declarative —
   *  the executor stamps it on the run-start event so every run records
   *  which version it executed (the orchestrationSnapshot is the executable
   *  pin; this is the human-legible one). In-flight/paused runs always resume
   *  against their snapshot, never a newer definition — see
   *  `makeLoadRunContext`'s `orchestrationOverride`, which every resume path
   *  supplies. What the snapshot pins is exactly: this tree, every subflow
   *  it reaches by a static `subflow:` name (transitively), and the raw body
   *  of every agent file any of those trees dispatches to (`__pinned`). What
   *  it does NOT pin: a `${dynamic}` subflow or agent name (resolved from run
   *  state against today's disk), the credentials / MCP / hooks registries,
   *  the model and provider defaults, and whatever the tools an agent calls
   *  do. (The "always resume against their snapshot" sentence was aspirational
   *  until 2026-10: the snapshot was written on every run and read only for
   *  `notify` config, so a resume re-walked whatever the file said at that
   *  moment — and until the closure existed, every subflow and agent body
   *  still came from today's disk.) */
  version?: string;
  agent?: string;
  agents?: string[];
  phases?: Node[];
  parallel?: Node[];
  converge?: Node[];
  subflow?: string;
  /** Refinement loop (see LoopBody). */
  loop?: LoopBody;
  /** Multi-turn dialogue between alternating agents (see ConversationBody). */
  conversation?: ConversationBody;
  /** Conditional branching by router-agent or substring match (see RouteBody). */
  route?: RouteBody;
  /** Deterministic value-based switch / case (see SwitchBody). */
  switch?: SwitchBody;
  /** Fan-out over an array (see MapBody). */
  map?: MapBody;
  /** Outbound dispatch to a remote A2A agent (see A2aBody). */
  a2a?: A2aBody;
  /** Inline JavaScript transform (see CodeBody). */
  code?: CodeBody;
  /** Durable timer / external-signal wait (see WaitBody). */
  wait?: WaitBody;
  merger?: string;
  lock?: boolean;
  input?: SchemaRef;
  output?: SchemaRef;

  // ── v2 decorators (apply to any node) ────────────────────────────────────
  /** Store this node's output in run state under this name; later nodes can
   *  reference it as `${name}` in any interpolated string. */
  as?: string;
  /** Skip this node when the interpolated predicate is falsy
   *  (empty / "false" / "0" / "null" / "undefined"). Previous lastOutput
   *  is preserved unchanged. */
  when?: string;
  /** End the run once this node completes — a controlled early return. The
   *  run finishes with this node's output; no later sibling/phase runs.
   *  Pair with `when` for a conditional exit ("return when ${...}"): a falsy
   *  `when` skips the node (no halt), a truthy one runs it and stops. The flag
   *  unwinds through every enclosing sequential composite (phases / loop /
   *  serial map). In-flight `parallel`/`map` siblings already running finish;
   *  the halt takes effect at the next sequential boundary. */
  halt?: boolean;
  /** Stable dedupe key for this phase's external side effect (interpolated —
   *  use ${vars} / ${as} state for run-scoped keys). On an `a2a` leaf it is
   *  sent as message metadata.idempotencyKey so a sammy-pack receiver can
   *  return the existing task for a repeated key instead of starting a
   *  duplicate run. Other node kinds ignore it today. */
  idempotencyKey?: string;
  /** Recovery branch — runs if this node fails after retries are exhausted.
   *  `${error.message}` is available inside the recovery branch. Its output
   *  replaces the failed node's output. */
  onError?: Node;
  /** Per-node wallclock timeout in seconds. Times out → TimeoutError, which
   *  then goes through retry / onError like any other failure. When unset,
   *  every node still gets a generous hard cap (DEFAULT_NODE_TIMEOUT_SEC,
   *  overridable via SAMMY_DEFAULT_NODE_TIMEOUT_SEC) — nothing runs unbounded. */
  timeout?: number;
  /** Stall watchdog in seconds: abort if this node yields NO progress event
   *  for this long, even while under its `timeout`. The timer resets on every
   *  event, so a slow-but-streaming node is never flagged — only a silently
   *  wedged one. Agent phases emit a throttled `phase-heartbeat` (≤ ~1/30s)
   *  whenever the SDK turn works without producing text or completed tool
   *  calls (thinking, streamed tool arguments), so event silence and
   *  watchdog silence are the SAME clock — extended event-stream silence on
   *  a running phase genuinely means a stall.
   *  Fires → StallError → retry / onError. When unset, defaults to
   *  DEFAULT_STALL_TIMEOUT_SEC (overridable via SAMMY_DEFAULT_STALL_TIMEOUT_SEC).
   *  Raise it for a node that legitimately runs long without emitting output. */
  stallTimeout?: number;
  /** Stall → recovery hook. When the stall watchdog aborts this node, run a
   *  recovery phase and re-run the node (up to `maxRetries`) instead of letting
   *  the stall abort the run. Distinct from `retry` (re-attempt with no fix-up)
   *  and `onError` (replace the node with a recovery branch's output): `onStall`
   *  runs a fix-up for its SIDE EFFECT, then re-runs the ACTUAL node. Only the
   *  stall watchdog firing (no-progress) triggers it; a hard timeout / generic
   *  error still flows through retry / onError. See {@link OnStallPolicy}. */
  onStall?: OnStallPolicy;
  /** Auto-retry on failure (transient API errors, timeouts). Distinct from
   *  `loop.retryOnFailure` which is iteration-level. */
  retry?: RetryPolicy;
  /** Token / cost circuit breaker for the run while inside this node. */
  budget?: Budget;
  /** Declared connectors/tools this leaf agent needs. Run start fails fast
   *  if any aren't configured. Surfaces required deps statically. */
  tools?: string[];

  /** Literal user-message override for this phase. When set, the agent
   *  receives this string (interpolated against state + scope) as its
   *  user message instead of the previous phase's output. Use when the
   *  orchestration needs to give a specific instruction to a phase
   *  that isn't naturally derivable from upstream — e.g. telling a
   *  shared QA agent which variant to test inside a map iteration
   *  (`"Test the ${item} checkout variant"`). */
  prompt?: string;

  /** Names of agents (from the agents/ registry) to expose as Task-tool
   *  subagents to THIS leaf agent. The orchestrator agent invokes them
   *  via Task("subagent-name", "prompt"). Sub-runs are observed by the
   *  SDK; their text + tool calls are folded into this phase's stream.
   *  When set, 'Task' is auto-added to the agent's effective tools list.
   *  Only honored by the Claude-Code-proxy auth path. */
  subagents?: string[];

  /** Names of MCP servers (from the workspace mcp/servers.json registry)
   *  to expose to this agent. The full server config — including any
   *  secrets in env / headers — stays server-side; the browser only
   *  passes the names. Only honored by the Claude-Code-proxy auth path. */
  mcp?: string[];

  /** Tool names to PRE-APPROVE for this phase so a headless (unattended)
   *  run never stalls waiting for a human "Allow". In a server run there is no
   *  human to answer the SDK's permission prompt, so a WRITE-capable MCP tool
   *  (e.g. `mcp__github__create_pull_request`) that requires permission would
   *  hang the phase indefinitely. Listing it here adds it to the SDK's
   *  `allowedTools` so it runs without a prompt. Accepts fully-qualified MCP
   *  tool ids (`mcp__<server>__<tool>`), a whole server (`mcp__<server>`), or a
   *  built-in tool name. Composes with the run-wide `SAMMY_ALLOWED_MCP_TOOLS`
   *  env. Only the Claude-Code-proxy auth path honors this. */
  autoApproveTools?: string[];

  /** Reasoning effort level for this agent. Higher levels mean deeper
   *  thinking + more tokens spent on the response. 'high' is the SDK
   *  default; bump to 'xhigh' / 'max' for hard tasks, drop to 'low' /
   *  'medium' for fast/cheap calls. Numeric value also accepted (advanced).
   *  Only the Claude-Code-proxy auth path honors this. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  /** Cap on extended-thinking token budget for this agent. Use to
   *  constrain cost on calls where you don't want unbounded reasoning.
   *  Pass 0 to disable thinking entirely. Only the Claude-Code-proxy
   *  auth path honors this. */
  maxThinkingTokens?: number;

  /** Per-phase SDK turn cap. Defaults to the proxy's 250-turn limit
   *  (which already bumped from the SDK's stock 25). Set higher for
   *  agents that drive long iterative flows — UI automation,
   *  simulator-driving, multi-file refactors — which routinely burn
   *  60+ turns per call. Set lower for sanity-check phases that
   *  shouldn't loop. */
  maxTurns?: number;

  /** Per-phase per-agent spend circuit-breaker, counted in COST-WEIGHTED
   *  ("input-equivalent") tokens summed across this agent's turns: fresh
   *  input ×1, cache writes ×1.25, cache READS ×0.1, output ×5. The
   *  weighting is the point — a long agent loop re-reads the same cached
   *  context every turn, so counting cache reads at face value made this a
   *  tax on DURATION rather than a runaway detector (a healthy hours-long
   *  supervision phase burned 30M in ~20 minutes while the SDK was
   *  auto-compacting its context). Exceeding it stops the leaf (soft
   *  per-leaf failure subject to retry / onError / continueOnError — NOT a
   *  run-fatal abort), and the error reports turns / elapsed / context
   *  trajectory / compactions so a runaway is distinguishable from long
   *  legitimate work. Use to give a known-heavy phase (e.g. a sim-vision
   *  agent re-sending a growing screenshot context) more headroom, or to
   *  tighten a cheap phase. Precedence: this field > SAMMY_MAX_AGENT_TOKENS
   *  env > built-in default (30M). Set 0 to disable the breaker for this
   *  phase. Node-level `budget.maxTokens` / `budget.maxCostUsd` remain the
   *  raw-token and USD caps for a subtree. Claude-Code-proxy path only. */
  maxAgentTokens?: number;

  /** When true, a failure inside this phase emits a phase-error
   *  event but the enclosing sequence (phases composite, map
   *  iteration, etc.) continues to the next phase instead of
   *  bubbling the error up. Use for "log it and move on" QA passes
   *  that should collect every defect in one run. Distinct from
   *  `retry` (re-attempt the SAME phase) and `onError` (run a
   *  recovery branch). */
  continueOnError?: boolean;

  /** Finalizer phase. When `true`, this phase runs after the other phases in
   *  its containing `phases` sequence EVEN IF a prior phase threw / timed out
   *  / the sequence is unwinding from an error — a try/finally for the
   *  sequence. Use it for aggregation / cleanup / triage that must always run
   *  (e.g. collate + file the findings of a long QA sweep even when one leg
   *  timed out). Best-effort: a `finally` phase honors its OWN timeout, and if
   *  it ITSELF errors that failure is surfaced but never masks the original
   *  error that unwound the sequence (the original still bubbles). Multiple
   *  `finally` phases run in declaration order. Only meaningful inside a
   *  `phases` sequence; ignored elsewhere. Composes with `continueOnError` /
   *  `onError` on the same node like any phase. */
  finally?: boolean;

  /** Top-level only: key/value pairs interpolated into descendant
   *  `prompt` strings, agent system prompts, and other interpolated
   *  fields as `${name}`. Useful for de-duplicating values that
   *  appear in many phases — simulator UDIDs, environment names,
   *  feature flags — so a rotation is one edit instead of many. */
  vars?: Record<string, string>;
  /** Top-level only: typed run inputs this orchestration accepts; resolved to
   *  content and seeded as ${name} before phase 1. */
  inputs?: InputDecl[];

  /** Top-level only: deployment stage + deprecation state. Drives the
   *  lifecycle-warning event the executor emits when a deprecated
   *  orchestration is run, and A2A discovery (deprecated orchestrations
   *  are hidden from the workspace root card by default). */
  lifecycle?: Lifecycle;

  /** Top-level only: named structured-state declarations with merge
   *  semantics. When a downstream phase writes to a declared key via
   *  `as:`, the value flows through the reducer instead of
   *  replacing — so a defect-collector phase inside a `map` can
   *  accumulate into a single list, an indexer can grow a single
   *  object, a counter can increment. Phases writing to keys NOT
   *  declared here keep the existing replace-on-write behavior, so
   *  this is purely additive — pre-existing orchestrations don't
   *  change. */
  state?: Record<string, StateDecl>;

  /** Top-level only: run-wide fallbacks for per-node resource limits
   *  (`timeout` / `stallTimeout` / `maxAgentTokens`). A node that omits one of
   *  these inherits the value declared here before falling back to the env /
   *  built-in default — so an orchestration sets a limit once instead of on
   *  every phase. Per-node values still win; omitting `defaults` is exactly the
   *  prior behavior. Read only off the orchestration root. */
  defaults?: OrchestrationDefaults;

  /** Top-level only: auto-approve every `lock: true` human gate in this
   *  orchestration instead of pausing for an interactive approval. Intended
   *  for UNATTENDED runs (cron / webhook) where no human is present to click
   *  Approve — without it a locked phase yields its gate and then blocks on
   *  `waitForApproval` forever, silently wedging the run. When `true` the gate
   *  still emits its `lock-gate` event (the audit trail is preserved) but the
   *  run proceeds as approved without pausing. Defaults to `false` (the prior
   *  behavior — every lock pauses for human approval). Read only off the
   *  orchestration root; a value on a child node is ignored. */
  autoApproveLocks?: boolean;

  /** Top-level only: how a run walks this orchestration (see
   *  {@link ExecutionMode}). Default `pipeline`; a run may override it. */
  execution?: ExecutionMode;

  /** Top-level only: harness-mode settings (see {@link HarnessConfig}). */
  harness?: HarnessConfig;

  /** A skill (Claude Code `SKILL.md`, by name or `plugin:skill`) the harness
   *  agent runs to do this step. Harness mode only — a pipeline run ignores it
   *  and runs the step's `agent` as usual. A step that names a skill nobody
   *  installed fails the run before it starts. */
  skill?: string;

  /** Top-level only: mutual exclusion for runs that share an external
   *  resource. When set, the server refuses to let two runs in the same
   *  `concurrency.group` overlap; `concurrency.policy` (skip / queue /
   *  cancel-existing, default queue) decides what a conflicting fire does.
   *  The group is an OPAQUE string — the framework knows nothing about the
   *  resource it stands for. Read only off the orchestration root; ignored on
   *  a child node. See {@link OrchestrationConcurrency}. */
  concurrency?: OrchestrationConcurrency;

  /** Top-level only: how this orchestration is invoked beyond the
   *  manual Run button. Webhook triggers expose POST /api/triggers/<path>;
   *  cron triggers fire on a schedule. Registered at server boot. */
  triggers?: Trigger[];

  /** Top-level only: outbound notification on run terminal. When
   *  `notify.onTerminal` is a URL, the server POSTs a small JSON envelope
   *  `{ runId, orchestration, status, summary? }` to it the moment the run
   *  reaches a terminal status (done / error / cancelled / paused).
   *  Best-effort and fire-and-forget — a slow / dead endpoint never blocks or
   *  fails the run; webhook errors are swallowed. A server-boundary feature
   *  (fired from the run's terminal hook, resolved at run start); the executor
   *  itself ignores it. Read only off the orchestration root. */
  notify?: NotifyConfig;

  /** Top-level only: per-orchestration limits on trigger-fired runs. See
   *  {@link OrchestrationLimits}. */
  limits?: OrchestrationLimits;

  /** Top-level only: isolated git worktrees created per run. See
   *  {@link WorktreeDecl}. */
  worktrees?: WorktreeDecl[];

  /** One HTTP request as a phase (no model). See {@link HttpBody}. */
  http?: HttpBody;

  /** Route this phase to a specific LLM provider. Defaults to the
   *  caller's configured stream function. Tool-use / subagents / MCP
   *  are Claude-specific features and silently no-op on non-Anthropic
   *  providers in this first cut. */
  provider?: ProviderId;

  /** Override the run-wide model for this phase. Pairs naturally with
   *  `provider` to pick a specific model on a specific provider. */
  model?: string;

  /** Named entry in the workspace credentials.json registry. Two
   *  independent uses (a phase may do either or both):
   *    1. Provider routing — when paired with `provider`, the executor
   *       uses THIS credential's value as the API key for this phase.
   *    2. Env injection — the credential is projected onto subprocess
   *       env vars by kind (jira → JIRA_API_TOKEN/JIRA_EMAIL/JIRA_BASE_URL,
   *       github → GITHUB_TOKEN, …; see server/credential-env.ts) and set
   *       ONLY in the spawned agent's OS environment — never in the prompt
   *       or context. Lets an agent's Bash/curl steps authenticate without
   *       the secret ever entering the model.
   *  Server-owned runs only (the registry is server-side). */
  credential?: string;

  /** Like `credential`, but several at once — each named entry is
   *  resolved and its env projection merged (later entries win on key
   *  collision) into the subprocess environment. Use when one phase needs
   *  more than one connection (e.g. Jira + GitHub). Provider routing still
   *  uses the singular `credential`. Server-owned runs only. */
  credentials?: string[];

  /** Names of hooks (from the workspace hooks/hooks.json registry) to
   *  attach to this phase's SDK call. Hooks are shell commands that
   *  fire before/after tool calls or other agent events. */
  hooks?: string[];

  /** Claude Code SDK permission mode for this agent's tool calls. Mirrors
   *  the CLI's --permission-mode flag. Effective only on leaf agents
   *  with tools[] and only via the Claude-Code-proxy auth path.
   *   - 'bypassPermissions' (default) — auto-approve everything; matches
   *     today's behavior. Use when the orchestration is trusted.
   *   - 'acceptEdits'  — auto-approve file edits; prompt on shell/network.
   *   - 'plan'         — read-only planning mode (no edits, no shell).
   *   - 'default'      — SDK's normal per-tool prompt (will likely block
   *     the run if nobody's there to answer).
   *  When unset, the proxy falls back to bypassPermissions when tools
   *  are present, undefined otherwise. */
  permissionMode?: 'bypassPermissions' | 'acceptEdits' | 'plan' | 'default';

  /** Execution-safety policy (see Sandbox). Set at the root for a
   *  run-wide default; set on a node to tighten it for that subtree.
   *  The executor resolves the effective policy by merging a node's
   *  sandbox with every ancestor's — children may only tighten. */
  sandbox?: Sandbox;

  /** UI metadata: per-phase positions for the Graph editor. CLI ignores. */
  _layout?: Record<string, [number, number]>;

  /** RUNTIME-ONLY provenance marker, set by the filesystem loader — NEVER
   *  persisted (the save path writes the authored node, not this). Tags where
   *  an orchestration came from so `subflow` name resolution can apply
   *  deterministic precedence: an `imported` (domain / workspace-symlinked)
   *  orchestration shadows a `shipped` (in-repo `examples/`) one of the SAME
   *  name. Without it, name resolution was last-readdir-wins, so the generic
   *  example could shadow the intended domain router. Absent ⇒ treated as the
   *  lowest precedence (shipped). Only a top-level orchestration node carries
   *  it; child phases never do. */
  __origin?: 'imported' | 'shipped';

  /** RUNTIME-ONLY closure pin, set by the filesystem loader on a FRESH load
   *  and — unlike `__origin` — PERSISTED on purpose: it rides inside the
   *  run's `orchestrationSnapshot` and is what makes a resume execute the
   *  subflows and agent bodies the run started under rather than today's
   *  files (see `makeLoadRunContext`). Never authored, never written back to
   *  an orchestration file. Holds ONLY the reachable closure — the agents
   *  referenced anywhere in this tree or a pinned subflow, and the subflows
   *  reachable by static `subflow:` name, transitively — so the row stays
   *  proportional to the run; `${dynamic}` names are not pinnable and keep
   *  resolving from disk. Absent ⇒ a snapshot written before closures
   *  existed; a resume then falls back to disk for both. Only a top-level
   *  orchestration node carries it; child phases never do. */
  __pinned?: {
    /** Agent name (file basename, no `.md`) → raw markdown as read. */
    agents: Record<string, string>;
    /** Orchestration `name` → its tree, minus the loader's runtime keys. */
    orchestrations: Record<string, Node>;
  };
};

export type CompositeKey =
  | 'agents'
  | 'phases'
  | 'parallel'
  | 'converge'
  | 'loop'
  | 'conversation'
  | 'route'
  | 'switch'
  | 'map';

export function compositeKey(node: Node): CompositeKey | null {
  if (node.agents) return 'agents';
  if (node.phases) return 'phases';
  if (node.parallel) return 'parallel';
  if (node.converge) return 'converge';
  if (node.loop) return 'loop';
  if (node.conversation) return 'conversation';
  if (node.route) return 'route';
  if (node.switch) return 'switch';
  if (node.map) return 'map';
  return null;
}

/** Visible child count for a composite — array length for the multi-child kinds,
 *  derived for loop/conversation/route/map. Used by the graph badge UI. */
export function compositeChildCount(node: Node, kind: CompositeKey): number {
  switch (kind) {
    case 'agents':
      return node.agents?.length ?? 0;
    case 'phases':
      return node.phases?.length ?? 0;
    case 'parallel':
      return node.parallel?.length ?? 0;
    case 'converge':
      return node.converge?.length ?? 0;
    case 'loop':
      return node.loop?.maxIterations ?? 0;
    case 'conversation':
      return node.conversation?.participants.length ?? 0;
    case 'route':
      return node.route
        ? Object.keys(node.route.branches).length + (node.route.default ? 1 : 0)
        : 0;
    case 'switch':
      return node.switch
        ? Object.keys(node.switch.cases).length + (node.switch.default ? 1 : 0)
        : 0;
    case 'map':
      return 1;
  }
}
