/**
 * Orchestration executor (v2.5).
 *
 * Recursive walk over a Node tree. Streams Anthropic responses, handles all
 * composite types, supports lock gates via a caller-provided approval callback.
 *
 * Composite semantics (run order):
 *   - `agents`        — serial chain of agents inside one phase
 *   - `phases`        — serial walk over child phases
 *   - `parallel`      — concurrent branches; events multiplexed
 *   - `converge`      — like parallel + optional `merger` agent on outputs
 *   - `loop`          — refinement loop; see LoopBody
 *   - `conversation`  — alternating turns over shared transcript
 *   - `route`         — conditional branching via router agent or substring
 *   - `map`           — fan-out over an array from state
 *   - `subflow`       — inline another orchestration by name (seeds its own vars; cycle-safe)
 *
 * Per-node decorators (apply in this order, outside the dispatch):
 *   1. `when`     — skip if predicate falsy (preserves lastOutput)
 *   2. `lock`     — gate: wait for human approval before entering
 *   3. `budget`   — push circuit breaker; checked after each agent call
 *   4. `retry`    — retry on failure up to N times
 *   5. `timeout`  — per-attempt wallclock cap (defaults to a generous backstop
 *                   when unset) + a stall watchdog (`stallTimeout`) that aborts
 *                   on no-progress; both feed retry / onError on fire
 *   6. `onError`  — recovery branch when retries exhausted
 *   7. `as`       — store output in state under this name (post-success)
 */

import { streamAnthropic, type Message, type StreamEvent } from './anthropic';
import {
  detectTerminalMarker,
  isTerminalFailure,
  TerminalPhaseError,
} from './terminal-failure';
import { callRemoteA2aAgent } from './a2a';
import { mergeIterators } from './merge';
import { decideLoopJudge, decideRoute } from './control-flow';
import { streamFnFor, type ProviderRegistry } from './providers';
import { agentSlots } from './concurrency';
import { interpolate, resolveOver, type ConnectionsMap, type State } from './interpolate';
import {
  codeRunAllowlist,
  codeRunChildEnv,
  codeRunEnvAllowlist,
  codeRunMode,
  matchAllowlist,
  splitArgv,
} from './code-run-policy';
import {
  HTTP_DEFAULT_MAX_RESPONSE_BYTES,
  performHttpRequest,
  prepareHttpRequest,
  statusOk,
  type PreparedRequest,
} from './http-node';
import {
  buildLookup,
  evalWhen,
  resolveAgentInput,
  resolveAgentPath,
  resolveCommand,
  classifyUnresolved,
  selectSwitchCase,
} from './resolution';
import { costUsd } from './pricing';
import { listAgents, listOrchestrations, type AgentFile } from '../api';
import {
  compositeKey,
  DEFAULT_NODE_TIMEOUT_SEC,
  type Budget,
  type HarnessFollow,
  type Node,
  type OrchestrationDefaults,
  type Sandbox,
} from '../types';
import { checkContract } from '../lib/json-schema-check';
import { childNodesOf } from '../lib/node-walk';
import {
  applyToolPolicy,
  checkDeniedCommand,
  mergeSandbox,
  resolvePermissionMode,
} from '../server/sandbox-policy';
import {
  AgentTokenCeilingError,
  ToolPermissionRequiredError,
} from '../server/sdk-stream';
import { credentialsToEnv } from '../server/credential-env';
import { scrubSecrets } from '../server/scrub-secrets';
import {
  buildHarnessSystemPrompt,
  clipForAgent,
  compileRoadmap,
  decodeStepRecord,
  encodeStepRecord,
  HARNESS_ALWAYS_ALLOWED,
  HARNESS_CHECKPOINT_PREFIX,
  HARNESS_SESSION_KEY,
  HARNESS_TOOL_SERVER,
  HarnessEventQueue,
  HarnessProgress,
  harnessToolId,
  HARNESS_TOOL_NAMES,
  kindLabel,
  resolveFollow,
  type FollowSource,
  type HarnessStep,
  type HarnessStepKind,
  type HarnessControl,
  type HarnessStreamOptions,
  type HarnessToolSpec,
  type ResolvedFollow,
  type StepRecord,
} from './harness';

export type CompositeKind =
  | 'agents'
  | 'phases'
  | 'parallel'
  | 'converge'
  | 'loop'
  | 'conversation'
  | 'route'
  | 'switch'
  | 'map'
  | 'subflow';

export type RunEvent =
  | {
      type: 'run-start';
      orchestrationName: string;
      /** The orchestration definition's declared root `version` (semver),
       *  when present — the run's human-legible definition pin (the
       *  orchestrationSnapshot is the structural one: the tree plus every
       *  reachable subflow and referenced agent body). */
      version?: string;
      ts: number;
    }
  | { type: 'run-end'; ts: number; status?: 'done' | 'error' | 'cancelled' }
  | {
      /** The run's isolated worktrees (root `worktrees`), emitted right after
       *  run-start — where each one is and which branch it is on. `reused`
       *  marks a resumed leg picking up the worktree a prior leg created. */
      type: 'worktrees-ready';
      worktrees: Array<{ name: string; path: string; branch: string; base: string; reused: boolean }>;
      ts: number;
    }
  | {
      /** A named, retrievable output of a phase (`code.artifact`): the full
       *  command log of a code.run step, bounded to its tail and scrubbed.
       *  Served by GET /api/runs/:id/artifacts[/:name]. */
      type: 'artifact';
      phaseName: string;
      name: string;
      mediaType: string;
      content: string;
      bytes: number;
      truncated: boolean;
      /** The run's artifact budget was spent: `content` is only a notice. */
      dropped?: boolean;
      /** Checkpoint key of the step that recorded it — how a fork knows
       *  exactly which artifacts belong to the steps it replays. */
      replayKey?: string;
      ts: number;
    }
  | { type: 'run-error'; error: string; ts: number }
  | { type: 'run-cancelled'; ts: number }
  | { type: 'run-halted'; phaseName: string; ts: number }
  | { type: 'run-paused'; pausedFor: string; ts: number }
  | { type: 'run-resumed'; pausedFor: string; ts: number }
  | { type: 'run-interrupted'; reason: string; ts: number }
  | { type: 'budget-halted'; reason: string; ts: number }
  | {
      type: 'lifecycle-warning';
      stage?: 'dev' | 'staging' | 'prod';
      deprecated?: boolean;
      reason?: string;
      ts: number;
    }
  | { type: 'composite-start'; phaseName: string; kind: CompositeKind; ts: number }
  | { type: 'composite-end'; phaseName: string; kind: CompositeKind; ts: number }
  | {
      /** A composite (`map` / `parallel` / `converge`) finalized with SOME —
       *  but not all — children's results. Two triggers:
       *
       *  1. DEADLINE: the fan-out hit its wallclock cap (explicit `timeout` or
       *     the default hard cap) with children still in flight. Instead of
       *     discarding everything (the old behavior — why a timed-out sweep
       *     produced no aggregated findings), the composite finalizes with the
       *     COMPLETED children's outputs. `failed` is absent.
       *
       *  2. FAILURE: the fan-out drained fully but some children FAILED
       *     (without `continueOnError`) while at least one succeeded. Instead
       *     of throwing away the sibling successes + their state merges (the
       *     old all-or-nothing behavior — partial failure treated as total),
       *     the composite emits one `phase-error` per failed child, finalizes
       *     with the successful children's outputs, and CONTINUES. `failed`
       *     carries the failed-child count. Only when EVERY child failed does
       *     the composite still throw.
       *
       *  `completed`/`total` count the finished vs fanned-out children; the
       *  partial output is what downstream phases receive as this node's
       *  output (and its `as` value). */
      type: 'composite-partial';
      phaseName: string;
      kind: CompositeKind;
      completed: number;
      total: number;
      /** Number of children that FAILED (failure-partial finalize only).
       *  Absent on a deadline partial — in-flight children didn't fail,
       *  they were abandoned. */
      failed?: number;
      ts: number;
    }
  | { type: 'phase-start'; phaseName: string; agentPath?: string; ts: number }
  | { type: 'phase-delta'; phaseName: string; text: string; ts: number }
  | {
      /** Throttled liveness beat (≤ ~1 per 30s per phase) forwarded from
       *  the SDK stream while the turn works without emitting anything
       *  else — thinking deltas, streamed tool-call arguments, block
       *  boundaries. Keeps event-stream silence and stall-watchdog silence
       *  the SAME thing (the beat both persists AND resets withStallGuard),
       *  so silence on a running phase genuinely means a stall, and the
       *  silent tail is diagnosable after the fact (`via` = newest activity
       *  label, counts cover everything since the previous beat). */
      type: 'phase-heartbeat';
      phaseName: string;
      via: string;
      messages: number;
      toolUses: number;
      textBytes: number;
      ts: number;
    }
  | {
      /** The SDK compacted this phase's context (its own auto-compaction at
       *  the context-window threshold, or a manual trigger). Recorded
       *  because it is the PROOF that a long phase's context is bounded
       *  rather than running away — the token-ceiling trip message reads
       *  the count — and because it explains an otherwise baffling
       *  discontinuity in the agent's narrative mid-phase. */
      type: 'phase-compacted';
      phaseName: string;
      trigger: 'manual' | 'auto';
      preTokens: number;
      postTokens?: number;
      ts: number;
    }
  | {
      type: 'phase-end';
      phaseName: string;
      output: string;
      inputTokens: number;
      outputTokens: number;
      /** USD cost of this single phase call (0 if model price is unknown). */
      costUsd: number;
      /** Wallclock duration of this phase, ms. */
      durationMs: number;
      /** Model id used for this phase. */
      model: string;
      /** Checkpoint key for this leaf — the phase name prefixed by its
       *  composite-iteration scope (loop iteration / map item / subflow
       *  instance), so repeated executions of one node checkpoint
       *  independently and resume replays each iteration's own output.
       *  Equal to phaseName for unscoped leaves. The run-controller stores
       *  leaf outputs under this key; display surfaces keep phaseName. */
      replayKey?: string;
      ts: number;
    }
  | { type: 'phase-skipped'; phaseName: string; reason: string; ts: number }
  | {
      /** Running spend-to-date snapshot, emitted after each agent phase folds
       *  its call into the run totals. Lets a live watcher (SSE) see how much a
       *  budget-bounded run has burned WITHOUT summing phase-ends itself — and
       *  the run-detail API derives the same number from the phase-ends, so the
       *  two always agree. `costUsd` / `inputTokens` / `outputTokens` are
       *  cumulative run-wide totals (not this phase's delta). */
      type: 'cost';
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      ts: number;
    }
  | {
      type: 'phase-error';
      phaseName: string;
      error: string;
      /** What the FAILED attempt spent, for agent leaves. A failed attempt
       *  never reaches its phase-end, and every spend reader (sumCostUsd,
       *  costSummary, the controller's mid-run gate) folded phase-ends
       *  only — so a `retry` storm's cost was invisible to the caps while
       *  each re-dispatch paid again. Present only on the leaf's own event
       *  (a composite re-emitting the failure carries no cost, so the
       *  readers never double-count); the figure is this attempt's delta,
       *  never the cumulative run total. */
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      ts: number;
    }
  | {
      /** A phase failed AND declared its failure TERMINAL (do-not-retry) —
       *  either by throwing a TerminalPhaseError or by emitting a
       *  `SAMMY-TERMINAL:` / `{"terminal":true}` marker in its output. The
       *  executor's re-run machinery (node `retry`, `onStall` re-run, loop
       *  `retryOnFailure`, a `request-changes` gate) MUST NOT re-run this
       *  phase — it surfaces the failure and proceeds (onError /
       *  continueOnError still apply). Emitted once, at the point the
       *  failure is recognised as terminal, so the run log shows WHY a
       *  retry/loop-back was suppressed (the anti-retry-storm signal).
       *  `retriesSuppressed` counts the re-attempts skipped because of the
       *  marker (the node's remaining `retry.times`). */
      type: 'phase-terminal';
      phaseName: string;
      reason: string;
      retriesSuppressed: number;
      ts: number;
    }
  | {
      type: 'interpolation-unresolved';
      phaseName: string;
      /** `${ref}` names that didn't resolve against run state — left as literals
       *  in the prompt/input. Surfaced as a visible warning so a silent miss
       *  (e.g. a stray `${releaseReport}` reaching a report) is caught instead
       *  of hiding as a typo-looking literal in the output. */
      refs: string[];
      ts: number;
    }
  | {
      /** A `${ref}` in this phase's prompt/input DID resolve — the binding
       *  exists — but to an EMPTY / whitespace value. Distinct from
       *  `interpolation-unresolved` (the ref bound to nothing): here an upstream
       *  `as` write produced no content (e.g. the producing agent truncated on
       *  its token ceiling before emitting its summary line), so the downstream
       *  phase runs on a silently-empty input and looks identical to success.
       *  `bindings` names the empty `as`-produced refs; surfaced as a
       *  degradation so a `done` run that fed a report phase nothing is flagged
       *  rather than silently green. */
      type: 'binding-empty';
      phaseName: string;
      bindings: string[];
      ts: number;
    }
  | {
      type: 'lock-gate';
      phaseName: string;
      /** Iteration-scoped checkpoint key for THIS gate instance — the display
       *  phaseName prefixed by its composite-iteration scope (loop iteration /
       *  map item / subflow instance), exactly like a leaf's `phase-end`
       *  replayKey. Equal to phaseName for an unscoped (top-level) gate. This is
       *  what disambiguates a gate repeated across map/loop iterations: a serial
       *  `map` body gate named `implement-and-qa` emits `…[0]/implement-and-qa`,
       *  `…[1]/implement-and-qa`, … so resume auto-approves each crossed
       *  iteration as a DISTINCT lock instead of collapsing them onto one bare
       *  name (the cause of the resume→re-pause loop on the 2nd iteration). */
      replayKey?: string;
      ts: number;
    }
  | {
      /** A `wait` leaf parked the run (durable timer or external signal).
       *  Carries the ABSOLUTE deadline (`resumeAt`, ms epoch) for timers —
       *  computed ONCE at first crossing, so a restart / early resume replays
       *  this event's deadline instead of re-arming the clock — and the
       *  interpolated `signal` name (+ optional `deadline`, ms epoch, from
       *  `timeoutSeconds`) for signal waits. `replayKey` is the wait
       *  instance's iteration-scoped checkpoint key, exactly like lock-gate's.
       *  `durable: true` = the run snapshot+paused (server-owned);
       *  `durable: false` = an in-memory wait (CLI / test executor). The
       *  server's wait-resolution derivation (server/wait-resolution.ts) reads
       *  these events to resume due timers and match buffered signals. */
      type: 'wait-started';
      phaseName: string;
      replayKey: string;
      kind: 'timer' | 'signal';
      resumeAt?: number;
      signal?: string;
      deadline?: number;
      durable: boolean;
      ts: number;
    }
  | {
      /** An external signal delivered to this run via
       *  POST /api/runs/:id/signal — appended by the API layer, never by the
       *  executor. Durably buffered: a signal that arrives BEFORE its `wait`
       *  leaf is reached is matched to it later by the wait-resolution
       *  derivation (FIFO per name, consumed at most once). `payload` is the
       *  delivered body as a string (JSON-stringified when non-string). */
      type: 'signal-received';
      signal: string;
      payload: string;
      ts: number;
    }
  | { type: 'loop-iteration'; phaseName: string; iteration: number; ts: number }
  | {
      type: 'loop-stopped';
      phaseName: string;
      iteration: number;
      reason: string;
      ts: number;
    }
  | {
      /** A `retryOnFailure` loop hit its per-item failure CAP (`maxFailures`)
       *  — that many CONSECUTIVE iterations failed — so it stopped re-doing the
       *  work instead of grinding through every `maxIterations`. The bound that
       *  caps a validate-fails-every-time retry storm. `failures` is the
       *  consecutive-failure count reached, `maxFailures` the configured cap,
       *  `iteration` the 1-based iteration that tripped it. (Distinct from
       *  `loop-stopped`, which is a SUCCESSFUL exit — until / whileOutput /
       *  judge — whereas this is a give-up.) */
      type: 'loop-exhausted';
      phaseName: string;
      iteration: number;
      failures: number;
      maxFailures: number;
      ts: number;
    }
  | {
      type: 'route-decision';
      phaseName: string;
      branch: string;
      /** A `switch` that took `default` because these `on` fields were
       *  missing on an existing value (informational — not a degradation). */
      unresolved?: string[];
      ts: number;
    }
  | {
      type: 'map-iteration';
      phaseName: string;
      iteration: number;
      total: number;
      ts: number;
    }
  | {
      type: 'node-retried';
      phaseName: string;
      attempt: number;
      maxAttempts: number;
      error: string;
      delayMs: number;
      ts: number;
    }
  | {
      type: 'node-recovered';
      phaseName: string;
      error: string;
      ts: number;
    }
  | {
      type: 'node-stalled';
      phaseName: string;
      /** Seconds of no-progress that tripped the watchdog. */
      stallSeconds: number;
      ts: number;
    }
  | {
      /** A node stalled (node-stalled), has an `onStall` policy, and retries
       *  remain — so instead of aborting, the executor runs the `onStall.recover`
       *  phase and then RE-RUNS the stalled node. This event marks that
       *  decision: `attempt` is the 1-based recovery attempt, `maxRetries` the
       *  configured ceiling, `stallSeconds` the no-progress window that tripped
       *  the watchdog. (A stall-recovery is a DEGRADATION — the run only finished
       *  because a fix-up + re-run rescued a wedged node; the done-degraded
       *  signal keys on this event.) */
      type: 'stall-recovery';
      phaseName: string;
      attempt: number;
      maxRetries: number;
      stallSeconds: number;
      ts: number;
    }
  | {
      type: 'budget-exceeded';
      phaseName: string;
      kind: 'tokens' | 'costUsd';
      limit: number;
      actual: number;
      ts: number;
    }
  | {
      type: 'tools-warning';
      phaseName: string;
      missing: string[];
      ts: number;
    }
  | {
      /** A headless (unattended) run hit a tool that needs an interactive
       *  permission "Allow" no one is present to give — the agent would stall
       *  forever. Emitted (loudly) the moment that's detected, right before the
       *  phase fails fast, so the run log shows WHY a phase died with no output
       *  instead of silently hanging. `toolName` is the permission-gated tool;
       *  pre-approve it via the phase's `autoApproveTools` or the run-wide
       *  SAMMY_ALLOWED_MCP_TOOLS env. Only fires on the headless path with
       *  fail-fast enabled (SAMMY_HEADLESS_TOOL_DENY). */
      type: 'awaiting-approval';
      phaseName: string;
      toolName: string;
      ts: number;
    }
  | {
      type: 'state-set';
      key: string;
      ts: number;
    }
  | {
      type: 'state-conflict';
      phaseName: string;
      key: string;
      ts: number;
    }
  | {
      type: 'phase-tool-use';
      phaseName: string;
      toolName: string;
      toolUseId: string;
      input: unknown;
      ts: number;
    }
  | {
      type: 'phase-tool-result';
      phaseName: string;
      toolUseId: string;
      output: string;
      isError: boolean;
      ts: number;
    }
  | {
      type: 'phase-paused';
      phaseName: string;
      /** Why we paused. 'user' = explicit Pause button click. 'max-turns'
       *  = the SDK exhausted its internal turn cap; the agent wasn't
       *  finished, just paused at a natural-ish break point. */
      reason: 'user' | 'max-turns';
      ts: number;
    }
  | {
      type: 'phase-resumed';
      phaseName: string;
      ts: number;
    }
  | {
      type: 'phase-user-message';
      phaseName: string;
      text: string;
      ts: number;
    }
  | {
      /** A human's decision at a paused `lock` gate — appended by the API
       *  gate handler (NOT emitted by the executor), so the user's side of
       *  the review conversation is part of the durable event log. Lets the
       *  Approvals thread interleave the human's feedback with the agent's
       *  successive plan/revision phase-end outputs. `phaseName` is the run's
       *  `pausedFor`; `message` is the human's free-text (empty when none). */
      type: 'gate-decision';
      phaseName: string;
      decision: 'approve' | 'reject' | 'request-changes';
      message: string;
      /** WHO decided — the resolved owner identity of the request that
       *  approved, rejected or returned this gate.
       *
       *  Without an actor, the gate's record cannot answer "who approved
       *  this release", which makes it unusable as evidence for any
       *  change-management or SOX-style process. Omitted only for decisions
       *  recorded before this field existed, so readers must tolerate it
       *  being absent on an old run. */
      decidedBy?: string;
      ts: number;
    }
  | {
      /** A harness leg began (execution: harness): the step list the agent
       *  follows, how strictly and why, and the session it works in — what
       *  the run page's checklist and its "resume in a terminal" command are
       *  built from. One per leg; a resumed leg repeats it (`leg` > 1). */
      type: 'harness-start';
      follow: HarnessFollow;
      followSource: FollowSource;
      /** A looser strictness the run asked for and a locked orchestration
       *  refused. */
      followRefused?: HarnessFollow;
      steps: Array<{
        key: string;
        name: string;
        kind: HarnessStepKind;
        rank: number;
        skill?: string;
        engineKind?: string;
        /** Locks guarding the step, outermost first. */
        gates?: string[];
        group?: string;
        section?: string;
        /** The loop the harness repeats this step in, its pass limit, and
         *  the pass it is on when the leg starts. */
        loop?: string;
        loopMax?: number;
        pass?: number;
        required: boolean;
        finally: boolean;
      }>;
      sessionId: string;
      /** The agent's working directory: `claude --resume` must run there. */
      cwd?: string;
      model: string;
      leg: number;
      /** Who drives this leg: the server's agent, or a person in a terminal. */
      driver?: 'server' | 'terminal';
      ts: number;
    }
  | {
      /** A harness step changed status. `done` / `skipped` / `failed` are
       *  checkpoints (`harness/<key>`, the record as JSON in `record`), so a
       *  resumed run knows what is finished; `started` is display only. */
      type: 'harness-step';
      key: string;
      phaseName: string;
      status: 'started' | 'done' | 'skipped' | 'failed';
      by: 'harness' | 'engine' | 'when';
      reason?: string;
      /** The checkpoint record (encodeStepRecord) — absent on `started`. */
      record?: string;
      replayKey?: string;
      ts: number;
    }
  | {
      /** Something about a harness run a reader should know that isn't a
       *  step: a session that couldn't be resumed, steps left unfinished
       *  when the agent stopped, credentials the whole session can see. */
      type: 'harness-notice';
      message: string;
      ts: number;
    };

type BudgetWatch = {
  budget: Budget;
  nodeName: string;
  /** Snapshot of run-wide totals when this budget was pushed; deltas are
   *  measured against these. */
  tokensAtEntry: number;
  costAtEntry: number;
};

/** Adapter shape both `streamAnthropic` (direct API key) and
 *  `streamClaudeCode` (proxied via CLI auth) satisfy. The executor picks
 *  the implementation at run-start time based on the caller's choice.
 *  `apiKey` is always passed (the proxy ignores it). */
/** Subagent definition the streamFn proxy will hand to the SDK as part
 *  of `options.agents`. We pre-resolve agent markdown into this shape
 *  so the proxy stays generic and doesn't have to know about our
 *  agents/ filesystem. */
export type SubagentSpec = {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  permissionMode?: 'bypassPermissions' | 'acceptEdits' | 'plan' | 'default';
};

export type StreamFn = (params: {
  apiKey: string;
  model: string;
  system?: string;
  messages: Message[];
  maxTokens?: number;
  /** Claude Code built-in tools to expose (Bash / Read / Write / etc.).
   *  Only the proxy adapter honors this. Direct API ignores. */
  tools?: string[];
  /** Per-call SDK permission mode override. Defaults to bypassPermissions
   *  when tools are present. Only the proxy adapter honors this. */
  permissionMode?: 'bypassPermissions' | 'acceptEdits' | 'plan' | 'default';
  /** Tool ids to PRE-APPROVE for a headless run (phase `autoApproveTools` ∪ the
   *  SAMMY_ALLOWED_MCP_TOOLS env) so a permission-gated MCP write tool never
   *  stalls waiting for a human "Allow". Merged into the SDK's `allowedTools`.
   *  Only the proxy adapter honors it. */
  autoApproveTools?: string[];
  /** Headless fail-fast: when true, a permission-gated tool that ISN'T
   *  pre-approved fails the phase fast (ToolPermissionRequiredError →
   *  `awaiting-approval`) instead of stalling. Set by the server on unattended
   *  runs (SAMMY_HEADLESS_TOOL_DENY). Only the proxy adapter honors it. */
  failOnToolPrompt?: boolean;
  /** Named subagents this call may dispatch via the Task tool. Pre-built
   *  AgentDefinition map keyed by subagent name. Only the proxy adapter
   *  honors this. */
  subagents?: Record<string, SubagentSpec>;
  /** Names of MCP servers (referencing entries in the workspace
   *  mcp/servers.json registry) to expose to this call. The proxy
   *  expands them to full server configs server-side. */
  mcp?: string[];
  /** Reasoning effort level for this call. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Cap on extended-thinking tokens for this call. */
  maxThinkingTokens?: number;
  /** Per-call SDK turn cap. Proxy defaults to 250 when omitted. */
  maxTurns?: number;
  /** Per-call per-agent token circuit-breaker ceiling. When omitted the
   *  proxy adapter falls back to SAMMY_MAX_AGENT_TOKENS, then its built-in
   *  default. Only the proxy adapter honors this. */
  maxAgentTokens?: number;
  /** Names of hooks (from the workspace hooks/hooks.json registry) to
   *  attach to this call. Proxy expands them to shell-command callbacks. */
  hooks?: string[];
  /** The phase sandbox's `deniedCommands`. An adapter that can refuse a
   *  single tool call (the server SDK path, via a PreToolUse hook) refuses a
   *  matching Bash command and lets the agent carry on; see
   *  `enforcesDeniedCommands`. */
  deniedCommands?: string[];
  /** Extra environment variables to inject into the spawned agent
   *  subprocess. SECURITY: the sanctioned sink for per-phase credential
   *  secrets — set here and ONLY here, never in `system` / `messages`.
   *  Only the proxy adapter (server SDK path) honors this; text-only
   *  provider adapters ignore it (they spawn no subprocess). */
  env?: Record<string, string>;
  /** Working directory for the spawned agent (the run's single worktree).
   *  Only the proxy adapter honors it. */
  cwd?: string;
  /** Harness session: in-process step tools, a session to start or resume,
   *  the skills it may run, and a per-call tool gate. Only the server SDK
   *  adapter honors it (see `harnessSupported` on runOrchestration). */
  harness?: HarnessStreamOptions;
}) => AsyncIterable<StreamEvent>;

type ExecutorContext = {
  apiKey: string;
  model: string;
  streamFn: StreamFn;
  agentByPath: Map<string, AgentFile>;
  /** Human-gate callback. `phaseName` is the gated node's bare display name
   *  (what the UI shows and `pausedFor` records — unchanged). `scopedKey` is
   *  the gate instance's iteration-scoped checkpoint key (the lock-gate
   *  event's `replayKey`), passed so a caller CAN disambiguate the same gate
   *  crossed across map/loop iterations; existing implementations ignore it. */
  waitForApproval: (phaseName: string, scopedKey?: string) => Promise<boolean>;
  cancelled: { v: boolean };

  /** Set true by a node carrying `halt: true` once it completes — a
   *  controlled early return. Every sequential composite (phases / loop /
   *  serial map) checks it after each child and stops; the flag unwinds up
   *  through the tree so the run ends with the halting node's output. */
  halted: { v: boolean };

  /** Output of the most recently completed phase. Threaded through the pipe. */
  lastOutput: string;

  /** Optional STRUCTURED output of the most recently completed phase, set by
   *  dispatch handlers that produce a real value (not just a string) for `as`
   *  storage — e.g. a `map` exposes its per-item outputs as a true array here
   *  while `lastOutput` stays the joined string used to pipe to the next phase.
   *  The `as` block in executeNode consumes-and-clears it: when present it's
   *  stored / folded into state instead of the joined string, so downstream
   *  `${results.0.field}` resolves into the array element. Reset to undefined
   *  at the start of every executeNode so a stale value never leaks. */
  lastOutputValue?: unknown;

  /** Absolute wallclock deadline (ms since epoch) for the CURRENT composite
   *  node's fan-out, threaded by executeNode from the node's resolved hard
   *  `timeout`. The parallel/map drain races each child-event pull against it
   *  so it can FINALIZE WITH PARTIALS — emit a `composite-partial` event +
   *  return the already-completed children's outputs — instead of being torn
   *  down by the outer `withTimeout` (whose `.return()` teardown would block on
   *  a still-running child and discard everything). Set per composite dispatch;
   *  undefined for leaves / non-composite nodes. */
  compositeDeadlineMs?: number;

  /** Run-scoped, mutable. `as: "name"` writes here. Shared by reference across
   *  parallel branches (last write wins — matches `converge` semantics). */
  state: State;

  /** Overlay state for scope-local vars: `${item}`, `${index}` inside a `map`,
   *  `${error.message}` inside an `onError` subtree. Per-call, never shared. */
  scope: State;

  /** Run-wide telemetry totals — for budget checks. */
  usage: { totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number };

  /** Active budgets, innermost last. Checked after every agent call. */
  budgets: BudgetWatch[];

  /** Connector ids configured in the workspace, for `tools` validation. */
  configuredTools: Set<string>;

  /** When true AND an agent declares `tools: [...]`, those tools are
   *  forwarded to the LLM via the proxy. False → tools are stripped
   *  with a `tools-warning` event. Off by default (user opt-in in
   *  Settings) since tool-equipped agents can run shell commands +
   *  edit files on the user's machine. */
  allowAgentTools: boolean;
  enforcesDeniedCommands: boolean;

  /** Mutable pause flag, set by the UI Pause button. Checked between
   *  agent exchanges; when true, the executor yields phase-paused and
   *  blocks until it flips back OR a chat message arrives. */
  paused: { v: boolean };

  /** Per-phase queue of chat messages the user has sent. Drained
   *  between exchanges; each dequeued message becomes the next user
   *  turn in the agent's conversation. */
  chatQueue: PhaseChatQueue;

  /** All orchestrations available for `subflow` lookup, keyed by name. */
  orchestrationByName: Map<string, Node>;

  /** Run-wide fallbacks for per-node resource limits, copied from the
   *  orchestration root's `defaults` at run start. A node that omits its own
   *  `timeout` / `stallTimeout` / `maxAgentTokens` falls back to the matching
   *  value here before the env / built-in default (see `resolveNodeLimits`).
   *  Empty `{}` for orchestrations that declare no `defaults` — exactly the
   *  prior behavior. */
  orchestrationDefaults: OrchestrationDefaults;

  /** When true, every `lock: true` human gate auto-approves WITHOUT pausing,
   *  copied from the orchestration root's `autoApproveLocks` at run start. For
   *  UNATTENDED runs (cron / webhook) where no human is present to approve a
   *  gate — otherwise the run blocks on `waitForApproval` forever. The gate
   *  still emits its `lock-gate` event so the audit trail is intact; only the
   *  pause is skipped. `false` for orchestrations that don't opt in — exactly
   *  the prior interactive-gate behavior. Distinct from `autoApproveLocks`
   *  (the resume-scoped per-iteration Set), which auto-approves ONE already-
   *  approved gate on a re-walk; this is the blanket unattended-mode switch. */
  autoApproveAllLocks: boolean;

  /** Names of orchestrations currently in the subflow call stack — for
   *  cycle detection. Mutated on push/pop around each subflow execution. */
  subflowStack: string[];

  /** Skip-replay table: replay key → captured output. When a leaf's
   *  replay key (see replayScope) appears here, the leaf returns the
   *  stored output instead of dispatching the SDK call — used by resume +
   *  pause/restart paths so a run picks up where it left off without
   *  re-executing already-completed work. Seeded on resume AND populated
   *  LIVE: every leaf checkpoints its output here the moment it succeeds,
   *  so an in-process re-run of an enclosing composite (node `retry`, an
   *  `onStall` recover-and-re-run) skips the already-completed children
   *  exactly like a resume — only the failed/stalled leaf (which never
   *  checkpointed) re-executes. Empty at the start of fresh runs. Shared
   *  by reference across branch/item contexts, so a completed child's
   *  checkpoint survives its composite's finalize. */
  replayOutputs: Map<string, string>;

  /** Composite-iteration scope for checkpoint/replay keys. Empty at the
   *  root; loop iterations append `name@N`, map items `name[idx]`, and
   *  subflows `name`, so a leaf executed repeatedly (same display name)
   *  still checkpoints each execution under its own key. Display
   *  phaseName stays unscoped — only the checkpoint key carries this. */
  replayScope: string;

  /** Auto-approve set for `lock: true` phases. When a phase's name is
   *  in this set, waitForApproval is bypassed (returns true). Used by
   *  resume to skip the gate the user already approved by clicking
   *  Resume — without this, the lock would fire again on the same
   *  phase and the run would re-pause forever. */
  autoApproveLocks: Set<string>;

  /** Human gate corrections → free-text instruction. When a human approves a
   *  paused lock gate WITH a message (POST /api/runs/:id/gate), the resumed
   *  run seeds this map; runAgentPhase appends the message to that phase's
   *  agent input as an explicit human-instruction block. A lock gates BEFORE
   *  the phase's agent runs, so the gated phase hasn't dispatched yet — its
   *  input is exactly where the correction belongs.
   *
   *  KEYING: preferred key is the phase's iteration-SCOPED checkpoint key
   *  (`replayKeyFor` — the same identity the lock gate itself uses), with the
   *  bare phase name as a compatibility fallback. Gate identity is
   *  iteration-scoped, so a bare-name key under a map/loop (or parallel
   *  same-named phases) could deliver an approve-with-message to the WRONG
   *  iteration — whichever same-named phase dispatched first consumed it.
   *  runAgentPhase therefore consumes scoped-key-first, bare-name-fallback,
   *  and deletes exactly the entry it matched. The run-controller seeds the
   *  scoped key when the paused gate's lock-gate event recorded one; API
   *  callers that only know the display name still work via the fallback.
   *  Empty for fresh runs and for plain (message-less) resumes. */
  gateMessages: Map<string, string>;

  /** Pending `wait` specs from a prior leg, keyed by the wait instance's
   *  iteration-scoped replay key (bare-name fallback on lookup, like
   *  autoApproveLocks). Seeded on resume from the run's unresolved
   *  `wait-started` events so a re-crossed wait re-parks against its
   *  ORIGINAL deadline instead of re-arming the clock (`seconds: 300`
   *  re-computed on every resume would postpone forever). Consumed on
   *  match. Empty for fresh runs. */
  pendingWaits: Map<string, PendingWaitSpec>;

  /** Buffered external signals, name → FIFO payload queue. Seeded from the
   *  run's `signal-received` events (minus already-consumed deliveries) on
   *  resume, so a signal that arrived while the run was elsewhere — even
   *  BEFORE its `wait` leaf was reached — is matched when the wait crosses.
   *  A `wait.signal` leaf shift()s one payload as its output. Note: a signal
   *  POSTed while a leg is LIVE lands only in the durable event log, not in
   *  this in-memory map; the wait then parks and the server's sweeper
   *  resolves it from the events on the next sweep (~30s). */
  deliveredSignals: Map<string, string[]>;

  /** When true (server-owned runs), a `wait` leaf that must actually wait
   *  parks DURABLY: emits `wait-started` and throws RunPauseRequested (the
   *  run snapshots + pauses at zero cost; the server resumes it when due).
   *  When false (in-memory executor — CLI, tests, browser), a timer wait
   *  sleeps in-process (abort-aware) and a signal wait with no buffered
   *  delivery fails loudly instead of hanging forever. */
  durableWaits: boolean;

  /** Resolved sandbox policy per phase name — precomputed at run
   *  start by walking the tree and merging each node's `sandbox` with
   *  every ancestor's (tighten-only). runAgentPhase looks its phase up
   *  here to cap tools, strip network access, pin the permission
   *  mode, and back-stop Bash commands. Absent = no policy. */
  sandboxByPhase: Map<string, Sandbox>;

  /** Optional per-provider stream functions. When a node sets
   *  `provider: "openai"` (or any registered id), runAgentPhase
   *  routes through this registry instead of ctx.streamFn. Empty /
   *  unset = today's behavior. */
  providerStreamFns: ProviderRegistry;

  /** Map of credential NAME → secret value from the workspace
   *  credentials.json registry. When a node sets both `provider` and
   *  `credential`, the executor builds a one-off StreamFn using
   *  that credential's value as the API key for THAT phase only.
   *  Server-owned runs only (the browser doesn't have the registry). */
  credentialsByName: Record<string, string>;

  /** Map of credential NAME → FULL credential entry (kind, fields, …)
   *  from the workspace credentials.json registry. Used to project a
   *  phase's `credential`/`credentials` onto subprocess env vars by kind
   *  (see server/credential-env.ts). Same scoping as `credentialsByName`.
   *  Server-owned runs only; empty in the browser / CLI default path. */
  credentialsRaw: Record<string, import('../server/credentials-store').Credential>;

  /** Run-scoped sink of every plaintext secret value injected into ANY
   *  agent subprocess this run. The run-controller reads it to scrub these
   *  literals from event text before persisting — so even a custom-format
   *  token an agent echoes back gets redacted. Mutated in runAgentPhase as
   *  each phase resolves its credentials. */
  injectedSecrets: Set<string>;
  /** Characters of artifact content this run has kept so far (shared by
   *  every nested context — a box, so spreads share it). */
  artifactBytes: { v: number };
  /** This leg's artifacts by (scoped) name — what an `http.files` upload
   *  attaches. A Map, so nested contexts share it. */
  artifactsByName: Map<string, { text: string; mediaType: string; dropped?: boolean }>;
  /** Artifacts an EARLIER leg of this run recorded (a resume after a gate):
   *  the server reads them from the stored run. */
  loadArtifact?: (
    name: string,
  ) => Promise<{ text: string; mediaType: string; dropped?: boolean } | undefined>;
  /** `SAMMY_WORKTREE_<NAME>` → path for every worktree the run was given;
   *  merged into every agent / code.run subprocess env. Empty when none. */
  worktreeEnv: Record<string, string>;
  /** Working directory for agents and code.run: the run's worktree when it
   *  declares exactly one; otherwise undefined (agents inherit the server
   *  cwd, code.run gets a throwaway temp dir). */
  defaultCwd?: string;

  /** Root-level `state` declarations: which keys have reducer
   *  semantics + their seed values. When `as:` writes to a key here,
   *  the new value is folded into the old via the reducer instead of
   *  replacing it. Undeclared keys stay replace-on-write. */
  stateDecls: Record<string, import('../types').StateDecl>;

  /** Owning run id + orchestration name, attached to each leaf's
   *  concurrency-queue waiter (for the Queue view + reorder API). Both
   *  optional — anonymous (in-browser / CLI) runs leave runId undefined. */
  runId?: string;
  orchestrationName?: string;

  /** Every name written by an `as:` decorator anywhere in the tree — the
   *  run-wide set of producer bindings. Computed once at run start. Used to tell
   *  an EMPTY `as`-produced ref (a `binding-empty` — an upstream that produced
   *  nothing) apart from an ordinary empty var / input, so only a real
   *  silent-truncation is flagged. */
  asProducers: Set<string>;
};

/** Fold an incoming `as:` write into the slot's current value per
 *  the reducer kind. The new value (always a string out of the agent)
 *  is parsed as JSON first — that's what lets a phase emit
 *  `[{ id: 1 }, { id: 2 }]` and have `append` actually concat the
 *  array elements instead of pushing the literal string. Falls back
 *  to the raw string when JSON.parse fails, which is the right thing
 *  for `concat` (which expects strings anyway) and for `replace`. */
function applyReducer(
  current: unknown,
  incomingRaw: string,
  reducer: import('../types').StateDecl['reducer'],
): unknown {
  return combineReducer(current, tryParseJson(incomingRaw), reducer);
}

/** Fold a parsed value into the slot's current value. Shared by
 *  `applyReducer` (string path from agent output) and the
 *  parallel/converge merge (already-parsed branch values). */
function combineReducer(
  current: unknown,
  incoming: unknown,
  reducer: import('../types').StateDecl['reducer'],
): unknown {
  switch (reducer) {
    case 'replace':
      return incoming;
    case 'append': {
      const base = Array.isArray(current) ? current : [];
      if (Array.isArray(incoming)) return [...base, ...incoming];
      return [...base, incoming];
    }
    case 'merge': {
      const base =
        current && typeof current === 'object' && !Array.isArray(current)
          ? (current as Record<string, unknown>)
          : {};
      const next =
        incoming && typeof incoming === 'object' && !Array.isArray(incoming)
          ? (incoming as Record<string, unknown>)
          : {};
      return { ...base, ...next };
    }
    case 'concat': {
      const baseStr = typeof current === 'string' ? current : '';
      const incStr =
        typeof incoming === 'string' ? incoming : String(incoming ?? '');
      return baseStr ? `${baseStr}\n${incStr}` : incStr;
    }
    case 'increment': {
      const baseN = typeof current === 'number' ? current : Number(current ?? 0);
      const incN =
        typeof incoming === 'number' ? incoming : Number(incoming);
      return (Number.isFinite(baseN) ? baseN : 0) +
        (Number.isFinite(incN) ? incN : 0);
    }
  }
}

/** Compute the per-branch delta against a snapshot for a reducer
 *  slot. Used by the parallel/converge merge to fold N branches'
 *  contributions into the parent without double-counting the seed.
 *  Each branch forked from the same `before` value, so the branch's
 *  final value = `before` + branch's contributions. We extract those
 *  contributions here. */
function reducerBranchDelta(
  before: unknown,
  branchValue: unknown,
  reducer: import('../types').StateDecl['reducer'],
): unknown {
  switch (reducer) {
    case 'replace':
      return branchValue;
    case 'append': {
      const beforeArr = Array.isArray(before) ? before : [];
      const branchArr = Array.isArray(branchValue) ? branchValue : [];
      // Branch starts with a copy of `beforeArr`; the contributions
      // are everything appended past that length.
      return branchArr.slice(beforeArr.length);
    }
    case 'merge': {
      const beforeObj =
        before && typeof before === 'object' && !Array.isArray(before)
          ? (before as Record<string, unknown>)
          : {};
      const branchObj =
        branchValue &&
        typeof branchValue === 'object' &&
        !Array.isArray(branchValue)
          ? (branchValue as Record<string, unknown>)
          : {};
      const delta: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(branchObj)) {
        if (!(k in beforeObj) || beforeObj[k] !== v) delta[k] = v;
      }
      return delta;
    }
    case 'concat': {
      const beforeStr = typeof before === 'string' ? before : '';
      const branchStr = typeof branchValue === 'string' ? branchValue : '';
      // If branch starts with `before + "\n"`, strip both; otherwise
      // strip just `before`. Fall back to the full branchStr if the
      // prefix doesn't match (branch overwrote rather than appended).
      if (branchStr.startsWith(beforeStr)) {
        const tail = branchStr.slice(beforeStr.length);
        return tail.startsWith('\n') ? tail.slice(1) : tail;
      }
      return branchStr;
    }
    case 'increment': {
      const beforeN = typeof before === 'number' ? before : Number(before ?? 0);
      const branchN =
        typeof branchValue === 'number' ? branchValue : Number(branchValue);
      return (Number.isFinite(branchN) ? branchN : 0) -
        (Number.isFinite(beforeN) ? beforeN : 0);
    }
  }
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Single-writer merge for a fan-out composite: fold the state writes of the
 * INCLUDED branch/item contexts back into the parent in INDEX order — not
 * completion order — so the merged state is identical regardless of which
 * child happened to finish first (what makes a converge deterministic: a
 * resume / replay reproduces the same state).
 *
 * One implementation shared by all four finalize paths (parallel/converge and
 * map; full-success, deadline-partial, and failure-partial): the fold logic
 * used to be copy-pasted per path and was already drifting. `include` selects
 * which children contribute — everything on a full success, only the FINISHED
 * children on a partial (in-flight / failed children's isolated contexts never
 * merge, so the partial is internally consistent).
 *
 * Semantics per key:
 *   - declared reducer keys: each child's DELTA against the pre-fork snapshot
 *     is folded via the reducer. Multiple children writing the same declared
 *     key is the whole point (a parallel QA pass appending to `defectList`) —
 *     never a conflict.
 *   - undeclared keys: last-included-index wins. A key written DIFFERENTLY by
 *     more than one included child is returned in `conflicts` so sequential
 *     callers can emit `state-conflict` diagnostics (the partial-finalize
 *     callers deliberately don't — matching their pre-extraction behavior).
 *
 * Generators can't `yield` from inside a plain helper, hence conflicts are
 * RETURNED rather than emitted.
 */
function foldIsolatedStates(
  ctx: ExecutorContext,
  stateBefore: State,
  contexts: ExecutorContext[],
  include: (idx: number) => boolean,
): string[] {
  const writers = new Map<string, number>();
  const conflicts: string[] = [];
  for (let i = 0; i < contexts.length; i++) {
    if (!include(i)) continue;
    const childState = contexts[i].state;
    for (const key of Object.keys(childState)) {
      if (childState[key] === stateBefore[key]) continue;
      const decl = ctx.stateDecls[key];
      if (decl) {
        const delta = reducerBranchDelta(
          stateBefore[key],
          childState[key],
          decl.reducer,
        );
        ctx.state[key] = combineReducer(ctx.state[key], delta, decl.reducer);
        writers.set(key, i);
        continue;
      }
      if (writers.has(key) && childState[key] !== ctx.state[key]) {
        conflicts.push(key);
      }
      ctx.state[key] = childState[key];
      writers.set(key, i);
    }
  }
  return conflicts;
}

function parseAgentBody(raw: string): { systemPrompt: string; description?: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const body = (m ? m[2] : raw).trim();
  const frontmatter = m ? m[1] : '';
  // Cheap YAML scan: just looking for `description: ...` (single or
  // multi-line via `>` / `|` block scalar). Most agent files keep
  // description on one line.
  let description: string | undefined;
  const descMatch = frontmatter.match(/^description:\s*([>|]?)\s*([\s\S]*?)(?:\n[a-zA-Z_]+:|$)/m);
  if (descMatch) {
    description = descMatch[2].trim().replace(/\s+/g, ' ');
  }
  return { systemPrompt: body, description };
}

/** Serialize a multi-turn conversation into a single user-prompt string
 *  for streamFn calls that only accept one user message. Adds clear
 *  USER:/ASSISTANT: markers + a continue nudge so the agent treats the
 *  transcript as context rather than as a fresh request. */
function serializeConversation(messages: Message[]): string {
  const transcript = messages
    .map(m => `${m.role.toUpperCase()}:\n${m.content}`)
    .join('\n\n');
  return `Continuing a conversation. Prior transcript:\n\n${transcript}\n\nContinue from where you left off, addressing the latest USER message.`;
}

/** Framework-level turn-lifecycle contract, appended to EVERY phase agent's
 *  system prompt. Exists because an agent that ends its turn with "pass in
 *  flight — I'll poll in 2 minutes" is assuming a scheduler it doesn't have:
 *  the executor captures that narrative as the phase's COMPLETE output and
 *  moves the graph on, shipping a partial result downstream with no signal.
 *  Per-agent .md rules don't scale — every agent is exposed — so the rule
 *  lives here, once. Pair with an
 *  `output` contract (e.g. {"type":"string","pattern":"## Converged board"})
 *  to fail fast when a partial slips through anyway. */
export const PHASE_TURN_CONTRACT =
  '\n\n---\n' +
  '[sammy-pack phase contract] You are one phase of an orchestrated run. ' +
  'Ending your turn ENDS this phase immediately: the orchestrator captures ' +
  'your final message as the phase’s complete output and moves on. You ' +
  'cannot wait, schedule, or "check back later" by ending your turn — ' +
  'there is no scheduler behind you. If work is still in flight (a detached ' +
  'job, a pending poll), keep the turn alive and poll it to completion ' +
  'before finishing. Your last message must be the phase’s complete ' +
  'deliverable.';

class RunCancelled extends Error {
  constructor() {
    super('run cancelled');
    this.name = 'RunCancelled';
  }
}

/** What a parked `wait` leaf is waiting FOR — carried on RunPauseRequested
 *  (durable pause path) and persisted by the run-controller into
 *  `stateJson.pendingWait` so the server's wait sweeper can spot a due run
 *  from the run HEADER alone (no event-stream read). The same shape is also
 *  derived from `wait-started` events on resume (server/wait-resolution.ts)
 *  — the event stream stays the source of truth; the header copy is only the
 *  sweeper's cheap index. */
export type PendingWaitSpec = {
  /** The wait instance's iteration-scoped checkpoint key (replayKeyFor). */
  replayKey: string;
  kind: 'timer' | 'signal';
  /** Timer: absolute due time, ms epoch (fixed at first crossing). */
  resumeAt?: number;
  /** Signal: the interpolated signal name being waited on. */
  signal?: string;
  /** Signal: optional absolute timeout, ms epoch (from `timeoutSeconds`). */
  deadline?: number;
};

/** Thrown by waitForApproval when a lock fires on a server-owned run
 *  that should snapshot+exit (not block in memory) — and by a `wait` leaf
 *  parking durably (then `wait` carries what it's waiting for). The
 *  run-controller catches this in runInBackground, writes status='paused' +
 *  the pausedFor phase (+ stateJson.pendingWait for waits), and exits
 *  cleanly. Treated like RunCancelled by the executor's try/catch sites —
 *  bubbles unchanged through onError / retry / parallel branches so it can
 *  never be silently swallowed. */
export class RunPauseRequested extends Error {
  pausedFor: string;
  /** Set when the pause is a parked `wait` leaf (not a human lock gate). */
  wait?: PendingWaitSpec;
  constructor(pausedFor: string, wait?: PendingWaitSpec) {
    super(`run paused at ${pausedFor}`);
    this.name = 'RunPauseRequested';
    this.pausedFor = pausedFor;
    this.wait = wait;
  }
}

/**
 * Thrown inside the streamFn for-await loop when the user clicks Pause
 * mid-stream. Distinguished from RunCancelled so the exchange-loop
 * catch site can re-enter the pause-wait state instead of bubbling up
 * as a real failure.
 *
 * Throwing out of the for-await calls the iterator's .return(), which
 * cancels our subscription to the SDK stream and closes the underlying
 * SSE connection. The SDK child processes for any in-flight tool MAY
 * continue running on the server (we can't abort them from here) — the
 * UI shows "paused" the moment we yield phase-paused, even if a Bash
 * call is still completing on disk. Subsequent exchanges start fresh.
 */
class PauseRequested extends Error {
  constructor() {
    super('pause requested');
    this.name = 'PauseRequested';
  }
}

class TimeoutError extends Error {
  constructor(
    seconds: number,
    opts?: { nodeName?: string; defaulted?: boolean },
  ) {
    // Name the node, and — when the cap was never author-chosen — SAY SO
    // with the fix: otherwise authors learn that unlisted phases get the
    // 1800s default only when a healthy evidence-heavy phase dies at it.
    super(
      `node${opts?.nodeName ? ` "${opts.nodeName}"` : ''} timed out after ${seconds}s` +
        (opts?.defaulted
          ? ' — this is the framework DEFAULT phase timeout (the phase sets ' +
            'no `timeout`). Set `timeout` on the phase, `defaults.timeout` ' +
            'on the orchestration root, or SAMMY_DEFAULT_NODE_TIMEOUT_SEC ' +
            'to raise it.'
          : ''),
    );
    this.name = 'TimeoutError';
  }
}

/** Thrown by `withStallGuard` when a node yields no progress event for
 *  `stallSeconds`. Distinct from TimeoutError (a fixed wallclock cap):
 *  the stall timer RESETS on every yielded event, so a slow-but-working
 *  node is never flagged — only a truly wedged one. Flows through retry /
 *  onError like any other failure. */
class StallError extends Error {
  stallSeconds: number;
  constructor(name: string, stallSeconds: number) {
    super(`node ${name} made no progress for ${stallSeconds}s — aborted by stall watchdog`);
    this.name = 'StallError';
    this.stallSeconds = stallSeconds;
  }
}

/**
 * Simple FIFO queue of user chat messages, partitioned by phase name.
 * The UI pushes messages via `enqueue(phaseName, text)`; the executor
 * drains them between exchanges. `has` lets the pause-wait loop break
 * early when a message arrives during a pause.
 */
export class PhaseChatQueue {
  private byPhase = new Map<string, string[]>();
  enqueue(phaseName: string, text: string): void {
    const list = this.byPhase.get(phaseName) ?? [];
    list.push(text);
    this.byPhase.set(phaseName, list);
  }
  dequeue(phaseName: string): string | undefined {
    return this.byPhase.get(phaseName)?.shift();
  }
  has(phaseName: string): boolean {
    return (this.byPhase.get(phaseName)?.length ?? 0) > 0;
  }
}

class BudgetExceededError extends Error {
  constructor(public kind: 'tokens' | 'costUsd', public limit: number, public actual: number) {
    super(`budget exceeded: ${kind} ${actual} > ${limit}`);
    this.name = 'BudgetExceededError';
  }
}

type ProtectedEvent<T> = { ok: T } | { err: Error };

/**
 * Wrap an async iterator so thrown errors become yielded events instead.
 * Used in parallel/converge so one branch's failure doesn't abort the
 * sibling branches' iterators inside `mergeIterators`.
 */
async function* protect<T>(iter: AsyncIterable<T>): AsyncIterable<ProtectedEvent<T>> {
  try {
    for await (const v of iter) yield { ok: v };
  } catch (err) {
    yield { err: err as Error };
  }
}

/**
 * Drain a composite's merged child-event stream, racing each event pull against
 * an absolute wallclock `deadlineMs`. Yields every event up to the deadline; the
 * moment the deadline passes (or has already passed) it stops, invokes
 * `onTimedOut`, fire-and-forgets the source's `.return()`, and ends — so the
 * caller can FINALIZE WITH PARTIALS.
 *
 * Why this exists: `executeNode` wraps every node in `withTimeout`, but that
 * wrapper's teardown does `await inner.return()`, which — for a composite whose
 * child is still running — BLOCKS on that pending child and never lets the
 * TimeoutError surface, so the completed children's results are lost. By having
 * the composite enforce its OWN deadline here and react via the normal `yield`
 * path (emit a partial, return cleanly), the partial is delivered downstream
 * BEFORE the outer hard cap ever fires. The `.return()` of the source is NOT
 * awaited (a hung child would block us too); the outer `withTimeout` /
 * run-controller reaper still guarantees orphaned work is ultimately cleaned up.
 *
 * `deadlineMs === undefined` disables the race entirely (plain pass-through) —
 * used so a composite with no resolved deadline behaves exactly as before.
 */
async function* drainWithDeadline<T>(
  source: AsyncIterable<T>,
  deadlineMs: number | undefined,
  onTimedOut: () => void,
): AsyncIterable<T> {
  if (deadlineMs === undefined) {
    yield* source;
    return;
  }
  const it = source[Symbol.asyncIterator]();
  let timedOut = false;
  try {
    while (true) {
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        return;
      }
      const next = it.next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<{ __deadline: true }>(resolve => {
        timer = setTimeout(() => resolve({ __deadline: true }), remaining);
        (timer as unknown as { unref?: () => void }).unref?.();
      });
      let result: IteratorResult<T> | { __deadline: true };
      try {
        result = await Promise.race([next, deadline]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if ('__deadline' in result) {
        timedOut = true;
        return;
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    if (timedOut) {
      onTimedOut();
      // Best-effort: signal the source to stop, but DON'T await — a still-running
      // (or wedged) child would block us, the exact hang this whole mechanism
      // exists to avoid. Orphaned work is reaped by the run-controller.
      try {
        void it.return?.(undefined);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Combine state + scope + reserved `input` var for interpolation lookups. */
/** Checkpoint/replay key for a leaf: the display name prefixed by the
 *  composite-iteration scope (see ExecutorContext.replayScope). Repeated
 *  executions of one node — loop iterations, map items, a subflow invoked
 *  twice — each get their own key, so resume replays each execution's own
 *  captured output instead of collapsing them onto one name. */
function replayKeyFor(ctx: ExecutorContext, name: string): string {
  return ctx.replayScope ? `${ctx.replayScope}/${name}` : name;
}

/** Walk a node subtree, merging each node's `sandbox` with the inherited
 *  (ancestor) policy — children may only tighten — and registering the
 *  effective policy under each named node in `out`. Recurses through every
 *  static composite via the shared `childNodesOf` walker (phases / parallel /
 *  converge / loop / map / route / switch / onError / onStall.recover — the
 *  hand-rolled walk this replaced MISSED `switch` cases, so a sandbox declared
 *  above a switch silently never reached the case-body leaves) but NOT
 *  `subflow` nodes: a subflow loads another orchestration by name at runtime,
 *  so its body isn't reachable from this static walk. The subflow handler in
 *  executeNode calls this again at dispatch time — once the referenced
 *  orchestration is resolved — passing the subflow node's own effective
 *  sandbox as `inherited`, so a `bypassPermissions` (or any) policy declared
 *  on or above the subflow node propagates into the nested orchestration's
 *  leaves instead of being lost (which silently dropped them to prompt-mode
 *  and denied every tool call in headless runs). */
function collectSandboxesInto(
  n: Node,
  inherited: Sandbox | undefined,
  out: Map<string, Sandbox>,
): void {
  const effective = mergeSandbox(inherited, n.sandbox);
  if (effective && n.name) out.set(n.name, effective);
  for (const child of childNodesOf(n)) {
    collectSandboxesInto(child, effective, out);
  }
}

/** Resolve the effective sandbox policy for a phase NAME, with a synthetic-
 *  child fallback. The run-start walk registers policies under the AUTHORED
 *  node names only — but several dispatch paths synthesize child nodes named
 *  `<parent>/<suffix>` (the `agents: [...]` chain, a converge `merger`, a
 *  route `router`, a loop `judge-N`, conversation `turn-N-<speaker>`). An
 *  exact `sandboxByPhase.get(syntheticName)` always missed, so ancestor
 *  sandbox policies silently did not apply to those leaves (a denylist on an
 *  `agents` node never reached its chain children). Fall back by stripping
 *  trailing `/suffix` segments one at a time — `a/b/c` tries `a/b`, then `a`
 *  — so a synthetic child inherits the nearest registered ancestor policy.
 *  Exact matches still win, so an authored name that happens to contain a
 *  slash resolves to its own policy first. */
function effectiveSandboxFor(
  name: string,
  byPhase: Map<string, Sandbox>,
): Sandbox | undefined {
  let candidate = name;
  for (;;) {
    const hit = byPhase.get(candidate);
    if (hit) return hit;
    const cut = candidate.lastIndexOf('/');
    if (cut === -1) return undefined;
    candidate = candidate.slice(0, cut);
  }
}

function lookupState(ctx: ExecutorContext, input: string): State {
  // Delegates to the shared `buildLookup` so the executor and the preview
  // walker build the interpolation lookup from the SAME code (state + scope +
  // reserved `input`, later spreads win). See resolution.ts.
  return buildLookup(ctx.state, ctx.scope, input);
}

/** Check every active budget against the current run totals; throw the first
 *  one that's tripped. Called after each agent call. */
function enforceBudgets(ctx: ExecutorContext): RunEvent | null {
  for (const w of ctx.budgets) {
    const usedTokens =
      ctx.usage.totalInputTokens + ctx.usage.totalOutputTokens -
      w.tokensAtEntry;
    const usedCost = ctx.usage.totalCostUsd - w.costAtEntry;
    if (w.budget.maxTokens != null && usedTokens > w.budget.maxTokens) {
      const ev: RunEvent = {
        type: 'budget-exceeded',
        phaseName: w.nodeName,
        kind: 'tokens',
        limit: w.budget.maxTokens,
        actual: usedTokens,
        ts: Date.now(),
      };
      // Caller throws; we just describe the breach.
      return ev;
    }
    if (w.budget.maxCostUsd != null && usedCost > w.budget.maxCostUsd) {
      const ev: RunEvent = {
        type: 'budget-exceeded',
        phaseName: w.nodeName,
        kind: 'costUsd',
        limit: w.budget.maxCostUsd,
        actual: usedCost,
        ts: Date.now(),
      };
      return ev;
    }
  }
  return null;
}

/** The ledger a failed SDK turn attaches to its error — sdk-stream's throw
 *  sites (per-agent ceiling, non-success result, headless tool block) stamp
 *  `err.usage` because the turn that died still consumed those tokens and
 *  the phase must charge them. Absent on errors from anywhere else. */
function usageOf(err: unknown): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
} | null {
  const u = (
    err as {
      usage?: {
        inputTokens?: unknown;
        outputTokens?: unknown;
        cacheReadTokens?: unknown;
        cacheWriteTokens?: unknown;
      };
    } | null
  )?.usage;
  if (
    !u ||
    typeof u.inputTokens !== 'number' ||
    typeof u.outputTokens !== 'number'
  ) {
    return null;
  }
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    ...(typeof u.cacheReadTokens === 'number' ? { cacheReadTokens: u.cacheReadTokens } : {}),
    ...(typeof u.cacheWriteTokens === 'number' ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
  };
}

async function* runAgentPhase(
  node: Node,
  agentPath: string,
  ctx: ExecutorContext,
  input: string,
): AsyncIterable<RunEvent> {
  // Parameterization: an agent path may itself reference state — e.g.
  // `agents/${component}-crawler.md` or a bare `${agentVar}` — so resolve it
  // against the current scope BEFORE the registry lookup. This lets one
  // orchestration dispatch to a different agent per map item / route branch
  // instead of needing N near-identical copies. Literal paths (no `${`) pass
  // through unchanged (interpolate is a no-op on them). Covers leaf `agent`,
  // the `agents[]` chain, `route.router`, and `loop.judge` — all four dispatch
  // through here. `resolveAgentPath` is the shared interpolation the preview
  // walker also uses to name the agent a phase would dispatch.
  agentPath = resolveAgentPath(agentPath, lookupState(ctx, input));
  const startMs = Date.now();
  yield {
    type: 'phase-start',
    phaseName: node.name,
    agentPath,
    ts: startMs,
  };

  // Skip-replay short-circuit: when resume gives us a stored output
  // for this phase, return it without dispatching the SDK. Emits a
  // phase-end so downstream phases see the same input they would have
  // on the original run, and ${as} state stays consistent because the
  // executor's stored value is what produced the captured output.
  // Keyed by the scoped replay key (not the bare name) so loop/map
  // iterations replay their OWN outputs. Falls back to the bare name
  // for checkpoints written before replay keys existed.
  const replayKey = replayKeyFor(ctx, node.name);
  const replayed =
    ctx.replayOutputs.get(replayKey) ??
    (ctx.replayScope === '' ? ctx.replayOutputs.get(node.name) : undefined);
  if (replayed !== undefined) {
    ctx.lastOutput = replayed;
    yield {
      type: 'phase-end',
      phaseName: node.name,
      output: replayed,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: Date.now() - startMs,
      model: ctx.model,
      replayKey,
      ts: Date.now(),
    };
    return;
  }

  const agent = ctx.agentByPath.get(agentPath);
  if (!agent) {
    // Don't emit phase-error here — the enclosing executeNode /
    // phases-composite / continueOnError handler catches the throw
    // and emits one with the correct semantics (and the right
    // ContinuOnError treatment). Emitting both here AND there
    // doubles the event in the log.
    throw new Error(`Agent file not found: ${agentPath}`);
  }

  const { systemPrompt } = parseAgentBody(agent.raw);
  // `node.prompt` is a literal user-message override. When set, it
  // replaces ctx.lastOutput as the agent's input — interpolation
  // still happens, so `${item}` (map scope), `${stateVar}` (as),
  // and `${input}` (raw upstream output) all work inside it.
  // `resolveAgentInput` is the shared resolution (prompt-override-or-input,
  // interpolated) that preview diffs its rendered prompts against byte-for-byte.
  // Collect `${...}` refs that don't resolve against run state across both the
  // input and the system prompt, so an unresolved ref surfaces as one visible
  // warning event per phase rather than a silent literal in the prompt/output.
  const unresolvedRefs = new Set<string>();
  // Empty `as`-produced bindings: a `${ref}` that RESOLVED (the binding exists)
  // but to an empty/whitespace value, AND whose base was written by an upstream
  // `as`. That's the silent-truncation footgun — an upstream agent that hit its
  // token ceiling before emitting output leaves its `as` value "", so this
  // phase runs on nothing yet looks like success. Recorded per producer base (a
  // deliberately-empty var / `${input}` is NOT flagged — only `as` outputs).
  const emptyBindings = new Set<string>();
  const noteEmpty = (ref: string): void => {
    const base = ref.split('.')[0].trim();
    if (base && ctx.asProducers.has(base)) emptyBindings.add(base);
  };
  let interpolatedInput = resolveAgentInput(
    node,
    input,
    lookupState(ctx, input),
    r => unresolvedRefs.add(r),
    noteEmpty,
  );

  // Human gate correction: when this phase was the one a paused lock
  // gate held on and the human approved WITH a free-text instruction,
  // append it to the agent's input as an explicit, clearly-fenced
  // human-instruction block. Consumed once (delete after read) so a
  // later phase with the same name can't accidentally re-receive it.
  // Done before system-prompt interpolation so a `${...}` inside the
  // human's message still resolves against current state.
  //
  // KEYING: gate identity is iteration-scoped (the lock gate keys on
  // `replayKeyFor`), so look the message up scoped-key-FIRST — under a
  // map/loop (or parallel same-named phases) a bare-name entry could be
  // consumed by the WRONG iteration (whichever same-named phase dispatched
  // first). The bare name stays as the fallback for callers that only know
  // the display name (the API's approve path, pre-scoping checkpoints).
  // Delete exactly the entry that matched, never both.
  const gateMessageKey = ctx.gateMessages.has(replayKey)
    ? replayKey
    : ctx.gateMessages.has(node.name)
      ? node.name
      : null;
  const gateMessage =
    gateMessageKey !== null ? ctx.gateMessages.get(gateMessageKey) : undefined;
  if (gateMessage && gateMessage.trim()) {
    ctx.gateMessages.delete(gateMessageKey!);
    interpolatedInput =
      `${interpolatedInput}\n\n--- HUMAN INSTRUCTION (gate approval) ---\n` +
      `${gateMessage.trim()}\n` +
      `--- END HUMAN INSTRUCTION ---`;
  }

  const interpolatedSystem =
    interpolate(
      systemPrompt,
      lookupState(ctx, interpolatedInput),
      r => unresolvedRefs.add(r),
      noteEmpty,
    ) + PHASE_TURN_CONTRACT;
  if (unresolvedRefs.size > 0) {
    yield {
      type: 'interpolation-unresolved',
      phaseName: node.name,
      refs: [...unresolvedRefs],
      ts: Date.now(),
    };
  }
  if (emptyBindings.size > 0) {
    yield {
      type: 'binding-empty',
      phaseName: node.name,
      bindings: [...emptyBindings],
      ts: Date.now(),
    };
  }

  // Runtime I/O-contract enforcement (input side). When the node
  // declares an inline `input` JSON Schema, the upstream output must
  // satisfy it before this phase runs — catches a mismatched handoff
  // at the boundary instead of letting the agent flail on bad input.
  const inCheck = checkContract(node.input, interpolatedInput);
  if (inCheck.enforce && !inCheck.ok) {
    throw new Error(
      `Phase "${node.name}" received input that ${inCheck.reason}`,
    );
  }

  // Tool resolution.
  //
  // `node.tools` carries two semantically different things historically:
  //   - Connector ids (lowercase like "github", "slack") — validated at
  //     run start against the workspace's configured connectors. Existing
  //     tools-warning event handles those.
  //   - Claude Code built-in tools (PascalCase like "Bash", "Read") —
  //     only become real when the user has opted into agent tool
  //     execution in Settings. The proxy adapter forwards them to the
  //     SDK; otherwise we strip + warn so it's obvious why nothing fired.
  //
  // Disambiguate by case: PascalCase → Claude Code tool; otherwise
  // assume connector and ignore here (run-start handles it).
  const declaredTools = Array.isArray(node.tools) ? node.tools : [];
  const claudeCodeTools = declaredTools.filter(t => /^[A-Z]/.test(t));
  // Resolve the sandbox policy for this phase (run-root merged with
  // every ancestor down to here — precomputed at run start). Synthetic
  // children (`<parent>/<suffix>` — agents-chain links, merger, router,
  // judge, conversation turns) aren't registered under their own name;
  // effectiveSandboxFor falls back to the nearest registered ancestor so
  // the parent's policy actually applies to them.
  const sandbox = effectiveSandboxFor(node.name, ctx.sandboxByPhase);
  let effectiveTools: string[] = [];
  if (claudeCodeTools.length > 0) {
    if (ctx.allowAgentTools) {
      // Apply the sandbox tool policy: intersect with the allowlist
      // + drop network tools when networkAccess is off. Stripped
      // tools surface as a tools-warning so the user sees that the
      // sandbox removed a capability the agent declared.
      const policy = applyToolPolicy(claudeCodeTools, sandbox);
      effectiveTools = policy.effectiveTools;
      if (policy.strippedTools.length > 0) {
        yield {
          type: 'tools-warning',
          phaseName: node.name,
          missing: policy.strippedTools.map(t => `sandbox-blocked:${t}`),
          ts: Date.now(),
        };
      }
    } else {
      yield {
        type: 'tools-warning',
        phaseName: node.name,
        missing: claudeCodeTools,
        ts: Date.now(),
      };
    }
  }

  // Subagent resolution. Each declared name must match an agent in the
  // registry (the same set runAgentPhase resolves leaf-agent paths
  // against). Missing names get a warning but don't fail the phase —
  // the orchestrator can still proceed without them.
  const subagents: Record<string, SubagentSpec> = {};
  if (Array.isArray(node.subagents) && node.subagents.length > 0 && ctx.allowAgentTools) {
    const missingSubagents: string[] = [];
    for (const subName of node.subagents) {
      const sub = ctx.agentByPath.get(`agents/${subName}.md`);
      if (!sub) {
        missingSubagents.push(subName);
        continue;
      }
      const parsed = parseAgentBody(sub.raw);
      subagents[subName] = {
        description: parsed.description ?? `Subagent ${subName}`,
        prompt: parsed.systemPrompt,
      };
    }
    if (missingSubagents.length > 0) {
      yield {
        type: 'tools-warning',
        phaseName: node.name,
        missing: missingSubagents.map(n => `subagent:${n}`),
        ts: Date.now(),
      };
    }
    // Task tool must be exposed for the orchestrator to dispatch — auto-add.
    if (Object.keys(subagents).length > 0 && !effectiveTools.includes('Task')) {
      effectiveTools.push('Task');
    }
  } else if (
    Array.isArray(node.subagents) &&
    node.subagents.length > 0 &&
    !ctx.allowAgentTools
  ) {
    // Subagents are a tool-execution feature; refuse silently if the
    // user hasn't opted in to tools, with the same warning surface.
    yield {
      type: 'tools-warning',
      phaseName: node.name,
      missing: node.subagents.map(n => `subagent:${n}`),
      ts: Date.now(),
    };
  }

  // Exchange loop. One "exchange" = one streamFn call run to completion
  // (or until the SDK's internal maxTurns cap). Between exchanges we
  // check: cancellation, the chat queue, the pause flag, and whether
  // the previous exchange hit the SDK's turn cap. Any of those drive a
  // subsequent exchange or a clean phase exit.
  //
  // Conversation history is serialized into a single user message for
  // each exchange (the streamFn API only takes a single user message
  // today). This means the agent re-reads its prior turns each time,
  // which is suboptimal token-wise but unblocks chat + pause/resume
  // without requiring a long-lived session protocol. Replacing this
  // with `AsyncIterable<SDKUserMessage>` is a future optimization.
  const conversation: Message[] = [
    { role: 'user', content: interpolatedInput || `Start the "${node.name}" phase.` },
  ];
  let aggregateOutput = '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  // Prompt-cache tokens (Anthropic): not in totalInputTokens, priced separately by costUsd.
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let exchangeIdx = 0;

  // Per-node provider override: if the node names a provider that's
  // registered, use its StreamFn for this phase only; otherwise fall
  // through to the run-wide ctx.streamFn. `model` is a parallel
  // per-node override. `credential` (when paired with `provider`)
  // builds a one-off StreamFn keyed on the named registry entry's
  // value, scoping a specific secret to this phase only. Resolved
  // once per phase so the cost / phase-end emission below uses the
  // same model the dispatch did.
  let streamFn = ctx.streamFn;
  if (node.provider) {
    let resolved = false;
    if (node.credential) {
      const credValue = ctx.credentialsByName[node.credential];
      if (credValue) {
        const oneOff = streamFnFor(node.provider, credValue);
        if (oneOff) {
          streamFn = oneOff;
          resolved = true;
        }
      }
    } else {
      const providerFn = ctx.providerStreamFns[node.provider];
      if (providerFn) {
        streamFn = providerFn;
        resolved = true;
      }
    }
    // Fail loud: an external provider declared but not configured (no key /
    // creds resolved) would otherwise SILENTLY fall back to the default
    // (Claude) streamFn — wrong-provider results with no signal. anthropic /
    // claude-code legitimately use the default streamFn, so they're exempt.
    if (
      !resolved &&
      node.provider !== 'anthropic' &&
      node.provider !== 'claude-code'
    ) {
      const msg =
        `phase "${node.name}" declares provider "${node.provider}" but no ` +
        `credentials are configured for it — refusing to silently run on the ` +
        `default provider`;
      yield { type: 'phase-error', phaseName: node.name, error: msg, ts: Date.now() };
      throw new Error(msg);
    }
  }
  // Routing a tool / subagent / mcp-declaring agent to a text-only provider
  // would silently drop those capabilities (the agent behaves differently —
  // it can't read files, search, etc.). Surface it loudly at run time as a
  // tools-warning (the author-time validator warns too, but the JSON may be
  // hand-edited or generated).
  if (node.provider && TEXT_ONLY_PROVIDERS.has(node.provider)) {
    const dropped: string[] = [];
    if (effectiveTools.length > 0) dropped.push(...effectiveTools);
    if (Object.keys(subagents).length > 0) dropped.push('subagents');
    if (Array.isArray(node.mcp) && node.mcp.length > 0) dropped.push('mcp');
    if (dropped.length > 0) {
      console.warn(
        `[executor] phase "${node.name}" routes to text-only provider "${node.provider}" — dropping ${dropped.join(', ')}`,
      );
      yield {
        type: 'tools-warning',
        phaseName: node.name,
        missing: dropped,
        ts: Date.now(),
      };
    }
  }
  const effectiveModel = node.model ?? ctx.model;

  /** Fold this dispatch's tokens into the run totals and return the delta.
   *  Called exactly once per dispatch on EVERY exit — the phase-end and each
   *  failure path — because a dispatch that paid for a model call spent that
   *  money whether or not it produced an output. Charging only on success
   *  meant `retry` re-dispatched and paid again while every spend reader saw
   *  nothing: the cost of a retry storm was invisible to the caps. */
  const chargeSpend = (): {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
  } => {
    const cost = costUsd(effectiveModel, totalInputTokens, totalOutputTokens, {
      cacheReadTokens: totalCacheReadTokens,
      cacheWriteTokens: totalCacheWriteTokens,
    });
    ctx.usage.totalInputTokens += totalInputTokens;
    ctx.usage.totalOutputTokens += totalOutputTokens;
    ctx.usage.totalCostUsd += cost;
    return {
      costUsd: cost,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    };
  };
  /** An abort unwind knows only what COMPLETED exchanges spent (the one in
   *  flight never reported its usage); null when nothing is known, so a
   *  phase cancelled inside its first turn adds no event. */
  const spendOnAbort = () =>
    totalInputTokens + totalOutputTokens > 0 ? chargeSpend() : null;
  const abortSpendEvent = (spent: {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
  }): RunEvent => ({
    type: 'phase-error',
    phaseName: node.name,
    error: `Phase "${node.name}" cancelled — charging the exchanges it completed`,
    ...spent,
    ts: Date.now(),
  });

  // Per-phase credential ENV injection. A phase may declare `credential`
  // (string) and/or `credentials` (string[]); each names a registry entry
  // that we project onto subprocess env vars by KIND (jira →
  // JIRA_API_TOKEN/JIRA_EMAIL/JIRA_BASE_URL, github → GITHUB_TOKEN, …).
  //
  // SECURITY INVARIANT: the resolved secret goes into `phaseEnv` and is
  // passed to streamFn → sdk-stream → the SDK `env` option ONLY. It is
  // never appended to `interpolatedSystem`, the prompt, or the
  // conversation — so it can't reach the model context or the event log.
  // We also record each plaintext value in ctx.injectedSecrets so the
  // run-controller can scrub it from any output the agent might echo back.
  //
  // Resolution uses the RAW registry (kind + fields), independently of the
  // provider-routing block above — a phase can do provider routing AND env
  // injection, just one, or neither. Unknown / unmapped kinds contribute
  // {} (credentialToEnv never throws), so a stray `credential` is a no-op
  // here rather than a hard failure.
  const credNames: string[] = [
    ...(typeof node.credential === 'string' && node.credential
      ? [node.credential]
      : []),
    ...(Array.isArray(node.credentials)
      ? node.credentials.filter(
          (n): n is string => typeof n === 'string' && !!n,
        )
      : []),
  ];
  let phaseEnv: Record<string, string> | undefined;
  if (credNames.length > 0) {
    const resolved = credNames
      .map(name => ctx.credentialsRaw[name])
      .filter((c): c is NonNullable<typeof c> => !!c);
    const env = credentialsToEnv(resolved);
    if (Object.keys(env).length > 0) {
      phaseEnv = env;
      // Record the SECRET values (the credential `value`, not the
      // non-secret field vars like base URL) for run-wide scrubbing.
      for (const c of resolved) {
        if (typeof c.value === 'string' && c.value) {
          ctx.injectedSecrets.add(c.value);
        }
      }
    }
  }

  while (true) {
    exchangeIdx++;
    const prompt =
      exchangeIdx === 1
        ? conversation[0].content
        : serializeConversation(conversation);

    let exchangeOutput = '';
    let exchangeInputTokens = 0;
    let exchangeOutputTokens = 0;
    let exchangeCacheReadTokens = 0;
    let exchangeCacheWriteTokens = 0;
    let hitMaxTurns = false;
    let userPaused = false;
    let exchangeError: Error | null = null;
    // Set when this exchange died because a headless tool needed approval — so
    // we can emit a loud `awaiting-approval` before the phase-error.
    let awaitingApprovalTool: string | null = null;

    // Global concurrency gate: bound how many agent-SDK subprocesses run at
    // once across the WHOLE process. Deadlock-free — only this leaf dispatch
    // holds a slot, for a single streamFn call, released in the `finally`
    // below; composites never hold one. A wide `parallel`/`map` or many
    // concurrent runs queue here (FIFO) instead of stampeding the machine.
    const willQueue = agentSlots.inUse >= agentSlots.limit;
    if (willQueue) {
      console.log(
        `[executor] phase "${node.name}" waiting for an agent slot ` +
          `(${agentSlots.inUse}/${agentSlots.limit} busy, ${agentSlots.waiting} queued)`,
      );
    }
    // Carry run/phase identity onto the queued waiter so the Queue view can
    // attribute this blocked dispatch + the reorder API can target it.
    const releaseSlot = await agentSlots.acquire({
      runId: ctx.runId,
      orchestrationName: ctx.orchestrationName,
      phaseName: node.name,
    });
    // A run cancelled while queued grabs its slot then bails immediately.
    if (ctx.cancelled.v) {
      releaseSlot();
      const spent = spendOnAbort();
      if (spent) yield abortSpendEvent(spent);
      throw new RunCancelled();
    }
    // Per-leaf token ceiling: a node value wins, else the orchestration's
    // `defaults.maxAgentTokens`, else (left undefined here) streamFn's own
    // SAMMY_MAX_AGENT_TOKENS / built-in default. Same `node.X ?? defaults.X`
    // precedence the timeout/stall site uses (see resolveNodeLimits).
    const { maxAgentTokens: resolvedMaxAgentTokens } = resolveNodeLimits(
      node,
      ctx.orchestrationDefaults,
    );
    try {
      for await (const ev of streamFn({
        apiKey: ctx.apiKey,
        model: effectiveModel,
        system: interpolatedSystem,
        messages: [{ role: 'user', content: prompt }],
        tools: effectiveTools.length > 0 ? effectiveTools : undefined,
        // The sandbox can only TIGHTEN the permission mode — the
        // stricter of the node's own setting and the sandbox floor.
        permissionMode: resolvePermissionMode(node.permissionMode, sandbox),
        // Pre-approve this phase's tools for a headless run so a permission-gated
        // MCP write tool doesn't stall waiting for an "Allow" (the server merges
        // in SAMMY_ALLOWED_MCP_TOOLS + the fail-fast switch).
        autoApproveTools:
          Array.isArray(node.autoApproveTools) && node.autoApproveTools.length > 0
            ? node.autoApproveTools
            : undefined,
        subagents: Object.keys(subagents).length > 0 ? subagents : undefined,
        mcp: Array.isArray(node.mcp) && node.mcp.length > 0 ? node.mcp : undefined,
        effort: node.effort,
        maxThinkingTokens: node.maxThinkingTokens,
        maxTurns: node.maxTurns,
        maxAgentTokens: resolvedMaxAgentTokens,
        hooks: Array.isArray(node.hooks) && node.hooks.length > 0 ? node.hooks : undefined,
        deniedCommands:
          sandbox?.deniedCommands && sandbox.deniedCommands.length > 0
            ? sandbox.deniedCommands
            : undefined,
        // Per-phase credential env injection (secret reaches ONLY the
        // spawned subprocess env — see the phaseEnv resolution above), plus
        // the run's worktree paths, plus SAMMY_RUN_ID so the server can tell
        // which run owns the agent's process (it never reaps another run's).
        env:
          Object.keys(ctx.worktreeEnv).length > 0 || ctx.runId
            ? {
                ...(ctx.runId ? { SAMMY_RUN_ID: ctx.runId } : {}),
                ...ctx.worktreeEnv,
                ...(phaseEnv ?? {}),
              }
            : phaseEnv,
        ...(ctx.defaultCwd ? { cwd: ctx.defaultCwd } : {}),
      })) {
        if (ctx.cancelled.v) throw new RunCancelled();
        // Mid-stream pause: any user-initiated pause flag flips during
        // the SDK's agent loop interrupt it at the next event boundary
        // (typically <1s — same cadence as the cancel check). Throws out
        // of the for-await, closes the SSE subscription, and the catch
        // below routes to the same pause-wait state used for max-turns.
        if (ctx.paused.v) throw new PauseRequested();
        if (ev.type === 'text-delta') {
          exchangeOutput += ev.text;
          yield {
            type: 'phase-delta',
            phaseName: node.name,
            text: ev.text,
            ts: Date.now(),
          };
        } else if (ev.type === 'tool-use') {
          // Sandbox denylist backstop: a Bash tool call whose command
          // contains a denied substring aborts the phase. The SDK has
          // usually already kicked off the subprocess by the time we
          // see this — the cancel path (AbortController) does the
          // actual kill; throwing here ends the phase as a failure.
          if (
            ev.name === 'Bash' &&
            ev.input &&
            typeof ev.input === 'object'
          ) {
            const cmd = (ev.input as { command?: unknown }).command;
            if (typeof cmd === 'string') {
              const hit = checkDeniedCommand(cmd, sandbox);
              if (hit && ctx.enforcesDeniedCommands) {
                // The adapter refused this one call before it ran and told
                // the agent why; record it and let the agent carry on.
                yield {
                  type: 'tools-warning',
                  phaseName: node.name,
                  missing: [`sandbox-refused:${hit}`],
                  ts: Date.now(),
                };
              } else if (hit) {
                throw new Error(
                  `Phase "${node.name}" — sandbox blocked a Bash command matching denied pattern "${hit}"`,
                );
              }
            }
          }
          yield {
            type: 'phase-tool-use',
            phaseName: node.name,
            toolName: ev.name,
            toolUseId: ev.toolUseId,
            input: ev.input,
            ts: Date.now(),
          };
        } else if (ev.type === 'tool-result') {
          yield {
            type: 'phase-tool-result',
            phaseName: node.name,
            toolUseId: ev.toolUseId,
            output: ev.output,
            isError: ev.isError,
            ts: Date.now(),
          };
        } else if (ev.type === 'compaction') {
          yield {
            type: 'phase-compacted',
            phaseName: node.name,
            trigger: ev.trigger,
            preTokens: ev.preTokens,
            ...(ev.postTokens !== undefined ? { postTokens: ev.postTokens } : {}),
            ts: Date.now(),
          };
        } else if (ev.type === 'heartbeat') {
          // Liveness beat from the SDK loop (sdk-stream throttles it):
          // persists as the phase's "still alive" signal AND feeds the
          // stall watchdog through message classes that yield nothing.
          yield {
            type: 'phase-heartbeat',
            phaseName: node.name,
            via: ev.via,
            messages: ev.messages,
            toolUses: ev.toolUses,
            textBytes: ev.textBytes,
            ts: Date.now(),
          };
        } else if (ev.type === 'done') {
          exchangeInputTokens = ev.usage.inputTokens;
          exchangeOutputTokens = ev.usage.outputTokens;
          exchangeCacheReadTokens = ev.usage.cacheReadTokens ?? 0;
          exchangeCacheWriteTokens = ev.usage.cacheWriteTokens ?? 0;
        }
      }
    } catch (err) {
      if (err instanceof RunCancelled) {
        const spent = spendOnAbort();
        if (spent) yield abortSpendEvent(spent);
        throw err;
      }
      if (err instanceof RunPauseRequested) throw err;
      if (err instanceof BudgetExceededError) throw err;
      // A turn that died inside the SDK still consumed tokens, and only the
      // thrower knows how many (`done` never arrived). sdk-stream attaches
      // them to its errors; take them as this exchange's usage so the failure
      // path below charges them like a completed exchange.
      const dead = usageOf(err);
      if (dead) {
        exchangeInputTokens = dead.inputTokens;
        exchangeOutputTokens = dead.outputTokens;
        exchangeCacheReadTokens = dead.cacheReadTokens ?? 0;
        exchangeCacheWriteTokens = dead.cacheWriteTokens ?? 0;
      }
      if (err instanceof PauseRequested) {
        userPaused = true;
      } else if (err instanceof AgentTokenCeilingError) {
        // Name WHICH phase + agent tripped it. sdk-stream is phase-agnostic
        // (it streams for whoever calls it), so the identity is attached
        // here, where the names live — an operator reading a run log full
        // of phases should not have to guess which one burned the ceiling.
        err.message = `phase "${node.name}" (${agentPath}) — ${err.message}`;
        // Per-agent token circuit-breaker tripped (runaway context). The SDK
        // stream stopped ITSELF by throwing — the shared run-wide signal is
        // NOT aborted, so this is a soft, per-leaf failure: treat it exactly
        // like any other exchange error so it flows through this phase's
        // retry / onError / continueOnError handling, instead of killing the
        // whole run the way the old abort()-the-shared-controller path did.
        exchangeError = err;
      } else if (err instanceof ToolPermissionRequiredError) {
        // Headless run hit a tool needing an interactive "Allow" no one can
        // give (it would otherwise stall forever). streamSdk denied it and
        // threw — record the tool so we emit a loud `awaiting-approval` below,
        // then fail the phase fast (soft per-leaf failure, subject to
        // retry / onError / continueOnError like any other exchange error).
        awaitingApprovalTool = err.toolName;
        exchangeError = err;
      } else if (/Reached maximum number of turns/i.test((err as Error).message)) {
        // Reached max turns is a soft pause-point, not a fatal error.
        // The agent did real work but didn't reach a final text response;
        // give the user the chance to let it continue or redirect.
        hitMaxTurns = true;
      } else {
        exchangeError = err as Error;
      }
    } finally {
      // Release the agent slot the moment this streamFn call ends — on
      // success, error, pause, or cancel. A paused agent (the wait loop
      // below) must NOT keep a slot; it re-acquires when it resumes.
      releaseSlot();
    }

    if (exchangeOutput) {
      // Scrub BEFORE the output re-enters any model context. This output
      // becomes (a) the assistant turn the agent re-reads next exchange and
      // (b) aggregateOutput → ctx.lastOutput, which is PIPED as the next
      // phase's input. If an agent echoed an injected secret into its text,
      // redacting here stops it leaking into a downstream prompt — the one
      // model-facing surface the event-log scrubber wouldn't cover. Redacts
      // known token patterns always + this run's injected literals.
      const cleanOutput = scrubSecrets(exchangeOutput, ctx.injectedSecrets);
      conversation.push({ role: 'assistant', content: cleanOutput });
      aggregateOutput = cleanOutput;
    }
    totalInputTokens += exchangeInputTokens;
    totalOutputTokens += exchangeOutputTokens;
    totalCacheReadTokens += exchangeCacheReadTokens;
    totalCacheWriteTokens += exchangeCacheWriteTokens;

    if (exchangeError) {
      // Loud headless-approval signal FIRST, so the run log shows a phase died
      // waiting on a permission prompt (not a mystery no-output failure) before
      // the generic phase-error rides the normal fast-fail path.
      if (awaitingApprovalTool !== null) {
        yield {
          type: 'awaiting-approval',
          phaseName: node.name,
          toolName: awaitingApprovalTool,
          ts: Date.now(),
        };
      }
      yield {
        type: 'phase-error',
        phaseName: node.name,
        error: exchangeError.message,
        ...chargeSpend(),
        ts: Date.now(),
      };
      throw exchangeError;
    }

    // Continuation logic — what drives a next exchange:
    //   1) User has sent a chat message → append, loop
    //   2) User clicked Pause OR SDK hit maxTurns → yield phase-paused,
    //      block until resume / chat / cancel
    //   3) Otherwise → phase done, exit loop
    if (ctx.chatQueue.has(node.name)) {
      const chat = ctx.chatQueue.dequeue(node.name)!;
      conversation.push({ role: 'user', content: chat });
      yield {
        type: 'phase-user-message',
        phaseName: node.name,
        text: chat,
        ts: Date.now(),
      };
      continue;
    }

    if (ctx.paused.v || userPaused || hitMaxTurns) {
      yield {
        type: 'phase-paused',
        phaseName: node.name,
        reason: hitMaxTurns ? 'max-turns' : 'user',
        ts: Date.now(),
      };
      // Wait for resume (paused flips to false), a chat message, or cancel.
      while (!ctx.cancelled.v) {
        if (ctx.chatQueue.has(node.name)) break;
        if (!ctx.paused.v && !hitMaxTurns) break;
        await new Promise(r => setTimeout(r, 200));
        // When pause-flag flips off, also clear hit-max-turns so we exit.
        if (hitMaxTurns && !ctx.paused.v) hitMaxTurns = false;
      }
      if (ctx.cancelled.v) {
        const spent = spendOnAbort();
        if (spent) yield abortSpendEvent(spent);
        throw new RunCancelled();
      }
      yield {
        type: 'phase-resumed',
        phaseName: node.name,
        ts: Date.now(),
      };
      if (ctx.chatQueue.has(node.name)) {
        const chat = ctx.chatQueue.dequeue(node.name)!;
        conversation.push({ role: 'user', content: chat });
        yield {
          type: 'phase-user-message',
          phaseName: node.name,
          text: chat,
          ts: Date.now(),
        };
      } else {
        // Plain resume with no new input — nudge the agent to continue.
        conversation.push({ role: 'user', content: 'Continue from where you left off.' });
      }
      continue;
    }

    break;
  }

  const spent = chargeSpend();
  const cost = spent.costUsd;

  // Runtime I/O-contract enforcement. When the node declares an
  // `output` as an inline JSON Schema, the agent is expected to emit
  // JSON matching it. A mismatch is a real failure — throw so it
  // flows through retry / onError / continueOnError like any other
  // phase error, instead of silently handing a wrong-shaped output
  // to the next phase. (The string form of a SchemaRef — a JSON
  // pointer / file path — is documentation only; checkContract
  // returns enforce:false for it.) The throw skips the phase-end, which
  // is every spend reader's only ledger — so emit the failed attempt's
  // cost on a phase-error first, or a contract-retry storm is free.
  const outCheck = checkContract(node.output, aggregateOutput);
  if (outCheck.enforce && !outCheck.ok) {
    const msg = `Phase "${node.name}" ${outCheck.reason}`;
    yield { type: 'phase-error', phaseName: node.name, error: msg, ...spent, ts: Date.now() };
    throw new Error(msg);
  }

  // RETRYABLE-vs-TERMINAL classification (anti-retry-storm). An agent that
  // CANNOT make progress — its tool/validator/infra is broken, not its
  // input — can declare its failure terminal by emitting a `SAMMY-TERMINAL:`
  // line (or `{"terminal":true}`) in its final output. Throwing a
  // TerminalPhaseError here routes it through the SAME catch sites as any
  // failure, but `isTerminalFailure` makes the re-run machinery (retry /
  // onStall / loop retryOnFailure / request-changes gate) SURFACE it instead
  // of re-running fine work. Absent the marker this is a no-op, so a normal
  // successful phase is unaffected.
  const terminalHit = detectTerminalMarker(aggregateOutput);
  if (terminalHit) {
    ctx.lastOutput = aggregateOutput;
    const msg = `Phase "${node.name}": ${terminalHit.reason}`;
    // Same ledger rule as the contract violation above: no phase-end follows.
    yield { type: 'phase-error', phaseName: node.name, error: msg, ...spent, ts: Date.now() };
    throw new TerminalPhaseError(msg);
  }

  yield {
    type: 'phase-end',
    phaseName: node.name,
    output: aggregateOutput,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    costUsd: cost,
    durationMs: Date.now() - startMs,
    model: effectiveModel,
    replayKey,
    ts: Date.now(),
  };
  // LIVE CHECKPOINT. Record the completed leaf's output under its scoped
  // replay key the moment its phase-end is DELIVERED — not just on resume. An
  // IN-PROCESS re-run of an enclosing composite (node `retry`, an `onStall`
  // recover-and-re-run) re-dispatches every child; before this, the completed
  // siblings re-executed from scratch (cost amplification — the failed leaf's
  // retry re-paid for all the fine work around it). With the checkpoint set,
  // the re-run's replay short-circuit (top of this function) returns the
  // stored output exactly as a resume would: a completed leaf replays, the
  // failed/stalled leaf never checkpointed so it genuinely re-runs. Failure
  // paths (contract violation, terminal marker, exchange error) all throw
  // before the phase-end, so only a success ever checkpoints. The replayed
  // path returned early above, so this never double-sets (and a double-set
  // would be a same-value no-op anyway).
  //
  // ORDERING — deliberately AFTER the yield. A watchdog abort
  // (`withStallGuard` / `withTimeout` calling `.return()` while this
  // generator is awaiting a wedged stream) is only processed at the next
  // suspension point: the yield above then evaluates as a `return` and the
  // phase-end is SWALLOWED — but code BEFORE that yield would still have
  // executed. A pre-yield checkpoint would therefore record a stall-aborted
  // leaf whose stream merely completed LATE as a success, and the onStall
  // re-run would replay that stale output instead of re-running — the exact
  // wedge the recovery exists to fix. After the yield, this line is reached
  // only when the phase-end was genuinely delivered downstream — matching
  // the run-controller's resume checkpoints, which also key off delivered
  // phase-end events. Memory: the output string is already retained by the
  // phase-end event — this adds one Map entry, not a copy.
  ctx.replayOutputs.set(replayKey, aggregateOutput);
  ctx.lastOutput = aggregateOutput;

  // Running spend snapshot — the live "how much has this burned" signal for a
  // budget-bounded run (the same total the run-detail API derives by summing
  // phase-ends, kept in agreement). Emitted after this agent's call is folded
  // into the run totals, so it rides every completed agent phase.
  yield {
    type: 'cost',
    costUsd: ctx.usage.totalCostUsd,
    inputTokens: ctx.usage.totalInputTokens,
    outputTokens: ctx.usage.totalOutputTokens,
    ts: Date.now(),
  };

  const breach = enforceBudgets(ctx);
  if (breach) {
    yield breach;
    throw new BudgetExceededError(
      (breach as Extract<RunEvent, { type: 'budget-exceeded' }>).kind,
      (breach as Extract<RunEvent, { type: 'budget-exceeded' }>).limit,
      (breach as Extract<RunEvent, { type: 'budget-exceeded' }>).actual,
    );
  }
}

/**
 * Outbound A2A leaf. Dispatches the phase to a remote agent over the
 * A2A protocol: submit the upstream output as a task, poll to a
 * terminal state, fold the result artifact in as this phase's output.
 *
 * Emits a `phase-start` with an `agentPath` so the run-controller
 * treats it as a leaf — it gets checkpointed and skip-replayed on
 * resume, exactly like an agent phase (we never want to re-invoke a
 * remote agent just because the run resumed).
 */
async function* runA2aPhase(
  node: Node,
  ctx: ExecutorContext,
  input: string,
): AsyncIterable<RunEvent> {
  const startMs = Date.now();
  const a2a = node.a2a!;
  const agentPath = `a2a:${a2a.agentCard}`;
  yield { type: 'phase-start', phaseName: node.name, agentPath, ts: startMs };

  // Skip-replay short-circuit (same contract as runAgentPhase): a
  // resumed run reuses the captured output instead of re-dispatching.
  const replayKey = replayKeyFor(ctx, node.name);
  const replayed =
    ctx.replayOutputs.get(replayKey) ??
    (ctx.replayScope === '' ? ctx.replayOutputs.get(node.name) : undefined);
  if (replayed !== undefined) {
    ctx.lastOutput = replayed;
    yield {
      type: 'phase-end',
      phaseName: node.name,
      output: replayed,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: Date.now() - startMs,
      model: ctx.model,
      replayKey,
      ts: Date.now(),
    };
    return;
  }

  const baseInput = node.prompt ?? input;
  const interpolatedInput = interpolate(baseInput, lookupState(ctx, input));
  const interpolatedCard = interpolate(a2a.agentCard, lookupState(ctx, input));

  // Input I/O-contract enforcement — same as a normal leaf agent.
  const inCheck = checkContract(node.input, interpolatedInput);
  if (inCheck.enforce && !inCheck.ok) {
    throw new Error(
      `Phase "${node.name}" received input that ${inCheck.reason}`,
    );
  }

  // Interpolated dedupe key — sent as A2A message metadata so the receiver
  // can return the existing task for a repeated key instead of starting a
  // duplicate run (the exactly-once seam for crashed-and-resumed dispatches).
  const idempotencyKey = node.idempotencyKey
    ? interpolate(node.idempotencyKey, lookupState(ctx, input))
    : undefined;

  let result: { output: string; state: string; taskId: string };
  try {
    result = await callRemoteA2aAgent({
      agentCard: interpolatedCard,
      skill: a2a.skill,
      input: interpolatedInput,
      cancelled: ctx.cancelled,
      idempotencyKey,
    });
  } catch (err) {
    if (ctx.cancelled.v) throw new RunCancelled();
    yield {
      type: 'phase-error',
      phaseName: node.name,
      error: (err as Error).message,
      ts: Date.now(),
    };
    throw err;
  }

  if (result.state !== 'completed') {
    if (result.state === 'canceled' && ctx.cancelled.v) {
      throw new RunCancelled();
    }
    const detail = result.output ? `: ${result.output}` : '';
    const msg =
      result.state === 'input-required'
        ? `A2A remote task needs additional input — unsupported for an outbound a2a phase`
        : `A2A remote task ended in state "${result.state}"${detail}`;
    yield {
      type: 'phase-error',
      phaseName: node.name,
      error: msg,
      ts: Date.now(),
    };
    throw new Error(msg);
  }

  // Output I/O-contract enforcement.
  const outCheck = checkContract(node.output, result.output);
  if (outCheck.enforce && !outCheck.ok) {
    throw new Error(`Phase "${node.name}" ${outCheck.reason}`);
  }

  ctx.lastOutput = result.output;
  yield {
    type: 'phase-end',
    phaseName: node.name,
    output: result.output,
    inputTokens: 0,
    outputTokens: 0,
    // Cost of a remote agent's own LLM calls is not visible to us.
    costUsd: 0,
    durationMs: Date.now() - startMs,
    model: ctx.model,
    replayKey,
    ts: Date.now(),
  };
  // LIVE CHECKPOINT — same contract (and same deliberate AFTER-the-yield
  // ordering) as runAgentPhase: a completed remote dispatch replays on any
  // in-process re-run of an enclosing composite (retry / onStall), so we
  // never re-invoke a remote agent for work that already succeeded — but a
  // watchdog-aborted dispatch whose yield was swallowed must NOT checkpoint.
  ctx.replayOutputs.set(replayKey, result.output);
}

/** In-memory wait keepalive cadence — re-emit `wait-started` (durable:false)
 *  so the stall watchdog (which resets on every event) doesn't flag a long
 *  legitimate in-process wait as a silently-wedged node. */
const WAIT_KEEPALIVE_MS = 120_000;

/**
 * Durable wait leaf (cost 0, tokens 0) — parks the run until a timer elapses
 * or an external signal arrives. Exactly one of `wait.seconds` /
 * `wait.until` / `wait.signal` (schema-enforced).
 *
 * DURABILITY: the deadline is computed ONCE at first crossing and travels on
 * the `wait-started` event + RunPauseRequested's `wait` payload; a resumed
 * leg re-enters through `ctx.pendingWaits` (original spec) or
 * `ctx.replayOutputs` (already resolved by the server's wait-resolution
 * derivation), so restarts and early resumes never re-arm the clock. On a
 * server-owned run (`ctx.durableWaits`) an unelapsed wait snapshots + pauses
 * exactly like a lock gate — zero cost while parked; the server's wait
 * sweeper resumes it when due, and POST /api/runs/:id/signal resumes a
 * signal wait immediately. In-memory runs sleep in-process (timers) and fail
 * loudly on an undeliverable signal wait rather than hanging forever.
 *
 * Signal payloads: the matching signal's payload string becomes this phase's
 * output (so `as` / downstream interpolation can consume it). Timer waits
 * output `{"waited":bool,"kind":"timer","resumeAt":iso}` — `waited: false`
 * when the deadline was already past at first crossing (e.g. `until` in the
 * past), so downstream `when` predicates can tell the difference.
 */
async function* runWaitPhase(
  node: Node,
  ctx: ExecutorContext,
  input: string,
): AsyncGenerator<RunEvent, void, undefined> {
  const startMs = Date.now();
  yield {
    type: 'phase-start',
    phaseName: node.name,
    agentPath: 'wait',
    ts: startMs,
  };

  const replayKey = replayKeyFor(ctx, node.name);
  const endEvent = (output: string): RunEvent => ({
    type: 'phase-end',
    phaseName: node.name,
    output,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: Date.now() - startMs,
    model: 'wait',
    replayKey,
    ts: Date.now(),
  });

  const replayed =
    ctx.replayOutputs.get(replayKey) ??
    (ctx.replayScope === '' ? ctx.replayOutputs.get(node.name) : undefined);
  if (replayed !== undefined) {
    ctx.lastOutput = replayed;
    yield endEvent(replayed);
    return;
  }

  // Runtime I/O-contract enforcement (input side) — same as runAgentPhase.
  // `input` is the upstream output this wait passes through untouched, so
  // it is the value held to the declared contract. Neither side was checked
  // here: a contract on a wait node type-checked, validated and previewed
  // clean and was then silently ignored at runtime. Checked BEFORE the
  // seeded spec is consumed, so a refused input leaves a resumed leg's
  // pending wait intact for the retry / onError path.
  const inCheck = checkContract(node.input, input);
  if (inCheck.enforce && !inCheck.ok) {
    throw new Error(
      `Phase "${node.name}" received input that ${inCheck.reason}`,
    );
  }

  // Runtime I/O-contract enforcement (output side) — same as runAgentPhase.
  // Applied at every site that PRODUCES this wait's output (a consumed
  // signal payload, an elapsed timer), never to a replayed one, which was
  // checked when it was first produced. Must run BEFORE the output is
  // checkpointed into replayOutputs, or a violation would replay as a
  // success on the next leg.
  const checkOutput = (output: string): void => {
    const outCheck = checkContract(node.output, output);
    if (outCheck.enforce && !outCheck.ok) {
      throw new Error(`Phase "${node.name}" ${outCheck.reason}`);
    }
  };

  // A prior leg's spec wins (scoped key first, bare-name fallback, consumed
  // on match — the autoApproveLocks discipline): the deadline was fixed at
  // that leg's first crossing, and recomputing `seconds` here would postpone
  // it on every resume.
  const seededKey = ctx.pendingWaits.has(replayKey)
    ? replayKey
    : ctx.pendingWaits.has(node.name)
      ? node.name
      : null;
  const seeded = seededKey !== null ? ctx.pendingWaits.get(seededKey) : undefined;
  if (seededKey !== null) ctx.pendingWaits.delete(seededKey);

  const w = node.wait!;
  const state = lookupState(ctx, input);
  let spec: PendingWaitSpec;
  let dueAtFirstCrossing = false;
  if (seeded) {
    spec = { ...seeded, replayKey };
  } else if (typeof w.signal === 'string') {
    const signalName = interpolate(w.signal, state).trim();
    if (!signalName) {
      const msg = `wait.signal interpolated to an empty string on phase "${node.name}"`;
      yield { type: 'phase-error', phaseName: node.name, error: msg, ts: Date.now() };
      throw new Error(msg);
    }
    spec = {
      replayKey,
      kind: 'signal',
      signal: signalName,
      ...(typeof w.timeoutSeconds === 'number' && Number.isFinite(w.timeoutSeconds)
        ? { deadline: Date.now() + Math.floor(w.timeoutSeconds * 1000) }
        : {}),
    };
  } else if (typeof w.until === 'string') {
    const raw = interpolate(w.until, state).trim();
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) {
      const msg =
        `wait.until "${raw}" on phase "${node.name}" is not a parseable ` +
        `ISO-8601 timestamp`;
      yield { type: 'phase-error', phaseName: node.name, error: msg, ts: Date.now() };
      throw new Error(msg);
    }
    dueAtFirstCrossing = t <= Date.now();
    spec = { replayKey, kind: 'timer', resumeAt: t };
  } else {
    const secs =
      typeof w.seconds === 'number' && Number.isFinite(w.seconds)
        ? Math.max(0, w.seconds)
        : 0;
    dueAtFirstCrossing = secs === 0;
    spec = { replayKey, kind: 'timer', resumeAt: Date.now() + Math.floor(secs * 1000) };
  }

  const timerOutput = (waited: boolean): string =>
    JSON.stringify({
      waited,
      kind: 'timer',
      resumeAt: new Date(spec.resumeAt ?? Date.now()).toISOString(),
    });

  if (spec.kind === 'signal') {
    // Buffered delivery (arrived while the run was elsewhere / paused —
    // seeded from durable signal-received events on resume) resolves the
    // wait immediately; the payload is this phase's output, consumed FIFO.
    const queue = ctx.deliveredSignals.get(spec.signal!);
    if (queue && queue.length > 0) {
      const payload = queue.shift()!;
      checkOutput(payload);
      ctx.lastOutput = payload;
      ctx.replayOutputs.set(replayKey, payload);
      yield endEvent(payload);
      return;
    }
    if (spec.deadline !== undefined && Date.now() >= spec.deadline) {
      const msg =
        `wait for signal "${spec.signal}" on phase "${node.name}" timed out ` +
        `(timeoutSeconds deadline ${new Date(spec.deadline).toISOString()} ` +
        `passed with no delivery)`;
      yield { type: 'phase-error', phaseName: node.name, error: msg, ts: Date.now() };
      throw new Error(msg);
    }
  } else if (Date.now() >= (spec.resumeAt ?? 0)) {
    // Timer already elapsed — zero-length wait, past `until`, or a resume
    // after the deadline (the normal durable-wake path).
    const out = timerOutput(!dueAtFirstCrossing);
    checkOutput(out);
    ctx.lastOutput = out;
    ctx.replayOutputs.set(replayKey, out);
    yield endEvent(out);
    return;
  }

  // Must actually wait.
  const waitStarted = (): RunEvent => ({
    type: 'wait-started',
    phaseName: node.name,
    replayKey,
    kind: spec.kind,
    ...(spec.resumeAt !== undefined ? { resumeAt: spec.resumeAt } : {}),
    ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
    ...(spec.deadline !== undefined ? { deadline: spec.deadline } : {}),
    durable: ctx.durableWaits,
    ts: Date.now(),
  });
  yield waitStarted();

  if (ctx.durableWaits) {
    // Server-owned: snapshot + pause at zero cost. The run-controller
    // persists `stateJson.pendingWait`; the server's wait sweeper (or the
    // signal endpoint) resumes the run, and this leaf re-enters via
    // replayOutputs (resolved) or pendingWaits (original spec).
    throw new RunPauseRequested(node.name, spec);
  }

  if (spec.kind === 'signal') {
    const msg =
      `wait.signal "${spec.signal}" on phase "${node.name}" requires a ` +
      `server-owned run: an in-memory executor has no durable pause and no ` +
      `POST /api/runs/:id/signal ingress, so the signal could never arrive. ` +
      `Run it via the server (POST /api/runs/start), or seed the signal ` +
      `before the wait is reached.`;
    yield { type: 'phase-error', phaseName: node.name, error: msg, ts: Date.now() };
    throw new Error(msg);
  }

  // In-memory timer: chunked abort-aware sleep, with a keepalive re-emission
  // so the stall watchdog doesn't flag a long legitimate wait.
  let lastKeepalive = Date.now();
  for (;;) {
    if (ctx.cancelled.v) throw new RunCancelled();
    const remaining = (spec.resumeAt ?? 0) - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(remaining, 1_000));
    if (Date.now() - lastKeepalive >= WAIT_KEEPALIVE_MS) {
      lastKeepalive = Date.now();
      yield waitStarted();
    }
  }
  const out = timerOutput(true);
  checkOutput(out);
  ctx.lastOutput = out;
  ctx.replayOutputs.set(replayKey, out);
  yield endEvent(out);
}

/**
 * Non-LLM transform leaf (cost 0, tokens 0). `node.code.source` is a pure
 * deterministic transform: it runs in a `vm` context whose global has only
 * `input` / `state` / `item` / `index` / `vars` + the JS built-ins — no
 * `require` / `process` / `fetch` / network / fs. CPU is bounded by
 * `sandbox.maxRunSeconds` (a vm watchdog interrupts synchronous loops a phase
 * `timeout` can't, since those block the event loop) plus a host-side race for
 * async hangs; output is capped by `sandbox.maxOutputBytes`. The return value
 * is the next phase's input.
 *
 * `node.code.run` (arbitrary `spawn(shell)`) is the escape-hatch form —
 * disabled unless SAMMY_ALLOW_CODE_RUN is set. It streams the child's stdout as
 * `phase-delta` progress events (live output + a stall-watchdog heartbeat) and,
 * like every node, is bounded by the default hard timeout + stall guard.
 *
 * Scope of the guarantee: vm removes ambient I/O and bounds CPU/output. It is
 * NOT a hardened boundary against a *malicious* author (vm constructor-escape
 * + microtask floods exist) — that needs OS-level isolation. For the
 * single-author model this closes the accidental-DoS + ambient-effect holes.
 */
const DEFAULT_CODE_RUN_SECONDS = 5;
const DEFAULT_CODE_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_MAX_FANOUT = 1000; // map fan-out blast-radius ceiling
/** How many trailing bytes of a failed `code.run`'s stderr / stdout to fold
 *  into the phase-error message. Bounded so a chatty failing script can't
 *  flood the event log, but large enough to carry a real stack trace. The
 *  TAIL is kept (not the head) because the actionable error is almost always
 *  at the END of the stream. */
const CODE_RUN_DIAG_TAIL_BYTES = 2000;

/** Hard wallclock cap applied to EVERY node that doesn't set its own
 *  `timeout`. Generous (30 min) so a legitimately long agent/drive is never
 *  cut off, but nothing runs truly unbounded — a node that hangs forever (and
 *  somehow also never trips the stall watchdog) still dies here. Overridable
 *  via SAMMY_DEFAULT_NODE_TIMEOUT_SEC. The number lives in types.ts
 *  (`DEFAULT_NODE_TIMEOUT_SEC`) as the single source of truth the offline
 *  `preview` linter shares — see its composite-no-timeout warning. */
/** Stall watchdog: a node that yields NO progress event for this many seconds
 *  is aborted (StallError) even if it's well under its hard timeout. Catches a
 *  silently-wedged node (a stuck agent, a hung drive) that the token-ceiling
 *  and wallclock cap both miss. Overridable via SAMMY_DEFAULT_STALL_TIMEOUT_SEC,
 *  or per-node via `stallTimeout`. */
const DEFAULT_STALL_TIMEOUT_SEC = 420;

/** Grace margin (ms) added to a fan-out composite's `withTimeout` backstop so
 *  the composite's OWN deadline-aware drain fires FIRST — emitting a
 *  `composite-partial` with the completed children's outputs and returning
 *  cleanly — before the hard wallclock cap would otherwise tear it down (and
 *  lose every result). Small relative to any real timeout; only the ordering of
 *  the two timers matters, not the exact value. */
const COMPOSITE_PARTIAL_GRACE_MS = 250;

/** Resolve a node's effective resource limits against the orchestration-level
 *  `defaults`, applying ONLY the `node.X ?? defaults.X` layer. The result is
 *  still `undefined` for any limit the node and the orchestration both leave
 *  unset — the caller then applies the existing env / built-in fallback
 *  (`DEFAULT_NODE_TIMEOUT_SEC`, `SAMMY_DEFAULT_STALL_TIMEOUT_SEC`,
 *  `SAMMY_MAX_AGENT_TOKENS`, …), so the prior behavior is preserved exactly
 *  when there are no defaults and no node value.
 *
 *  Pure and side-effect-free — a node + a defaults bag in, three optional
 *  numbers out — which is what makes the precedence directly unit-testable
 *  without standing up a full run. Both the timeout/stall site and the
 *  `maxAgentTokens` dispatch site funnel through it so the precedence is
 *  defined in exactly one place. */
export function resolveNodeLimits(
  node: Pick<Node, 'timeout' | 'stallTimeout' | 'maxAgentTokens'>,
  defaults: OrchestrationDefaults | undefined,
): { timeout?: number; stallTimeout?: number; maxAgentTokens?: number } {
  return {
    timeout: node.timeout ?? defaults?.timeout,
    stallTimeout: node.stallTimeout ?? defaults?.stallTimeout,
    maxAgentTokens: node.maxAgentTokens ?? defaults?.maxAgentTokens,
  };
}

/** Read a positive-number env override; falls back to `dflt` when unset,
 *  empty, non-numeric, or <= 0. Resolved per-call (not module-load) so a test
 *  / server can set the env before a run and have it take effect. */
function envSeconds(name: string, dflt: number): number {
  const raw = (globalThis.process as { env?: Record<string, string | undefined> })
    ?.env?.[name];
  if (raw == null || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** Providers whose adapters are text-only — they drop node-level tools /
 *  subagents / mcp. Used to warn (not silently no-op) when an agent that
 *  declares those is routed to one. anthropic + claude-code support them. */
// Providers whose adapter is TEXT-GENERATION ONLY — tools, subagents and MCP
// are dropped (with a warning) for a phase routed to one.
//
// `anthropic` belongs here and was missing. `streamAnthropic` takes
// {apiKey, model, system, messages, maxTokens} and has no tool, subagent or
// MCP support at all, and `providers.ts` routes `provider: "anthropic"`
// straight to it — so a phase declaring `provider: "anthropic"` plus `tools`
// silently lost them with no warning, while every doc named only
// openai/gemini/bedrock as text-only. The full agentic path is the Claude
// CODE proxy (`claude-code`), not the direct Anthropic API.
const TEXT_ONLY_PROVIDERS = new Set([
  'openai',
  'gemini',
  'bedrock',
  'anthropic',
]);

/** code.run is usable at all: unrestricted (SAMMY_ALLOW_CODE_RUN) or
 *  allowlisted (SAMMY_CODE_RUN_ALLOW). See llm/code-run-policy.ts. */
function codeRunEnabled(): boolean {
  return codeRunMode() !== 'off';
}

/** Max bytes of a code.run artifact (the command log) kept — the TAIL, where
 *  a failure's evidence lives. SAMMY_ARTIFACT_MAX_BYTES overrides. */
const DEFAULT_ARTIFACT_MAX_BYTES = 256 * 1024;
/** Total artifact characters one run may keep (SAMMY_ARTIFACT_RUN_MAX_BYTES). */
const DEFAULT_ARTIFACT_RUN_MAX_BYTES = 8 * 1024 * 1024;

/** node:vm via a runtime lookup (no import — the executor is bundled for the
 *  browser too). Undefined off Node, where there's no ambient host to remove. */
function getVm():
  | {
      createContext(o: object): object;
      Script: new (
        code: string,
        opts?: { filename?: string },
      ) => { runInContext(ctx: object, opts?: { timeout?: number }): unknown };
    }
  | undefined {
  const getBuiltin = (
    globalThis.process as unknown as {
      getBuiltinModule?: (id: string) => unknown;
    }
  )?.getBuiltinModule;
  return getBuiltin?.('node:vm') as ReturnType<typeof getVm>;
}

/** The `http` leaf: one allowlisted HTTP request, the response body as the
 *  phase output. See llm/http-node.ts for the guard rails. Checkpointed like
 *  every leaf, so a resumed run REPLAYS a completed request's output instead
 *  of sending it again — a write-back must not double-post. */
async function* runHttpPhase(
  node: Node,
  ctx: ExecutorContext,
  input: string,
): AsyncIterable<RunEvent> {
  const startMs = Date.now();
  yield { type: 'phase-start', phaseName: node.name, agentPath: 'http', ts: startMs };

  const replayKey = replayKeyFor(ctx, node.name);
  const replayed =
    ctx.replayOutputs.get(replayKey) ??
    (ctx.replayScope === '' ? ctx.replayOutputs.get(node.name) : undefined);
  if (replayed !== undefined) {
    ctx.lastOutput = replayed;
    yield {
      type: 'phase-end',
      phaseName: node.name,
      output: replayed,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: Date.now() - startMs,
      model: 'http',
      replayKey,
      ts: Date.now(),
    };
    return;
  }

  const inCheck = checkContract(node.input, input);
  if (inCheck.enforce && !inCheck.ok) {
    throw new Error(`Phase "${node.name}" received input that ${inCheck.reason}`);
  }

  const spec = node.http!;
  const fail = function* (msg: string): Generator<RunEvent, never> {
    yield { type: 'phase-error', phaseName: node.name, error: msg, ts: Date.now() };
    throw new Error(msg);
  };

  let prepared: PreparedRequest;
  try {
    prepared = prepareHttpRequest(
      spec,
      lookupState(ctx, input),
      ctx.credentialsRaw as unknown as ConnectionsMap,
    );
  } catch (err) {
    // Even a refused request may have resolved a credential; scrub it from
    // everything the run records from here on.
    for (const sec of (err as { secrets?: string[] }).secrets ?? []) ctx.injectedSecrets.add(sec);
    return yield* fail(scrubSecrets((err as Error).message, ctx.injectedSecrets));
  }
  // Scrub every credential the request carried from the run's output.
  for (const sec of prepared.secrets) ctx.injectedSecrets.add(sec);
  if (prepared.unresolved.length > 0) {
    yield {
      type: 'phase-delta',
      phaseName: node.name,
      text:
        `warning: unresolved reference(s) left literal in the request: ` +
        prepared.unresolved.map(r => '${' + r + '}').join(', ') + '\n',
      ts: Date.now(),
    };
  }
  if (ctx.cancelled.v) throw new RunCancelled();

  const ac = new AbortController();
  const poll = setInterval(() => {
    if (ctx.cancelled.v) ac.abort(new Error('run cancelled'));
  }, 200);
  // `files`: resolve each artifact — this leg's first (scoped name, then the
  // bare one), then one an earlier leg of the run recorded.
  const fileContents = new Map<string, { text: string; mediaType: string }>();
  for (const f of prepared.form?.files ?? []) {
    const scoped = replayKeyFor(ctx, f.artifact);
    const hit =
      ctx.artifactsByName.get(scoped) ??
      ctx.artifactsByName.get(f.artifact) ??
      (await ctx.loadArtifact?.(scoped)) ??
      (await ctx.loadArtifact?.(f.artifact));
    if (!hit) {
      clearInterval(poll);
      return yield* fail(`http: no artifact named "${f.artifact}" in this run to upload`);
    }
    if (hit.dropped) {
      // Uploading the budget notice in place of the log would look like a
      // success with the wrong attachment.
      clearInterval(poll);
      return yield* fail(
        `http: artifact "${f.artifact}" was dropped (the run's artifact budget, ` +
          'SAMMY_ARTIFACT_RUN_MAX_BYTES, was spent) — nothing to upload',
      );
    }
    fileContents.set(f.artifact, hit);
  }
  let res: { status: number; body: string; truncated: boolean };
  try {
    res = await performHttpRequest(prepared, {
      timeoutSeconds: spec.timeoutSeconds,
      maxResponseBytes: spec.maxResponseBytes,
      signal: ac.signal,
      fileContent: name => fileContents.get(name),
    });
  } catch (err) {
    clearInterval(poll);
    if (ctx.cancelled.v) throw new RunCancelled();
    return yield* fail(scrubSecrets((err as Error).message, ctx.injectedSecrets));
  }
  clearInterval(poll);

  const body = scrubSecrets(res.body, ctx.injectedSecrets);
  if (!statusOk(res.status, spec.expectStatus)) {
    const tail = body.length > CODE_RUN_DIAG_TAIL_BYTES ? `…${body.slice(-CODE_RUN_DIAG_TAIL_BYTES)}` : body;
    return yield* fail(
      `http: ${prepared.method} ${prepared.url} returned ${res.status}` + (tail ? `\n${tail}` : ''),
    );
  }
  if (res.truncated) {
    yield {
      type: 'phase-delta',
      phaseName: node.name,
      text: `warning: response truncated at ${spec.maxResponseBytes ?? HTTP_DEFAULT_MAX_RESPONSE_BYTES} bytes\n`,
      ts: Date.now(),
    };
  }

  const outCheck = checkContract(node.output, body);
  if (outCheck.enforce && !outCheck.ok) {
    throw new Error(`Phase "${node.name}" ${outCheck.reason}`);
  }
  ctx.lastOutput = body;
  yield {
    type: 'phase-end',
    phaseName: node.name,
    output: body,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: Date.now() - startMs,
    model: 'http',
    replayKey,
    ts: Date.now(),
  };
  ctx.replayOutputs.set(replayKey, body);
}

async function* runCodePhase(
  node: Node,
  ctx: ExecutorContext,
  input: string,
): AsyncIterable<RunEvent> {
  const startMs = Date.now();
  // Mark as a leaf via agentPath so the run-controller checkpoints
  // it and a resume skip-replays the captured output (same contract
  // as agent / a2a leaves).
  yield {
    type: 'phase-start',
    phaseName: node.name,
    agentPath: 'code',
    ts: startMs,
  };

  const replayKey = replayKeyFor(ctx, node.name);
  const replayed =
    ctx.replayOutputs.get(replayKey) ??
    (ctx.replayScope === '' ? ctx.replayOutputs.get(node.name) : undefined);
  if (replayed !== undefined) {
    ctx.lastOutput = replayed;
    yield {
      type: 'phase-end',
      phaseName: node.name,
      output: replayed,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: Date.now() - startMs,
      model: 'code',
      replayKey,
      ts: Date.now(),
    };
    return;
  }

  // Runtime I/O-contract enforcement (input side) — same as runAgentPhase.
  // `input` is exactly what the transform receives (the `input` global for
  // `source`, the stdin pipe for `run`), so it is the value held to the
  // declared contract. This check was missing: `input` is declared on the
  // flat Node type for every kind and the validator emits no warning, so a
  // contract on a code node type-checked, validated and previewed clean and
  // was then silently ignored here while the agent runner enforced it.
  const inCheck = checkContract(node.input, input);
  if (inCheck.enforce && !inCheck.ok) {
    throw new Error(
      `Phase "${node.name}" received input that ${inCheck.reason}`,
    );
  }

  const item = (ctx.scope.item as unknown) ?? undefined;
  const index = (ctx.scope.index as unknown) ?? undefined;
  const vars: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx.state)) {
    if (k !== 'input') vars[k] = v;
  }

  // The code node now honors its effective sandbox (it previously ignored it).
  // Resolved with the synthetic-child fallback so a code leaf synthesized (or
  // authored) under a `<parent>/<suffix>` name inherits the ancestor policy.
  const sandbox = effectiveSandboxFor(node.name, ctx.sandboxByPhase);
  const maxRunSeconds = sandbox?.maxRunSeconds ?? DEFAULT_CODE_RUN_SECONDS;
  const maxOutputBytes =
    sandbox?.maxOutputBytes ?? DEFAULT_CODE_MAX_OUTPUT_BYTES;

  let result: unknown;
  if (node.code!.run) {
    // Arbitrary host shell — opt-in only.
    const runMode = codeRunMode();
    if (runMode === 'off') {
      const msg =
        'code.run is disabled (arbitrary shell execution). Set ' +
        'SAMMY_ALLOW_CODE_RUN=1 to enable it, SAMMY_CODE_RUN_ALLOW to allow ' +
        'specific commands, or use an agent with the Bash tool — which the ' +
        'sandbox policy governs.';
      yield {
        type: 'phase-error',
        phaseName: node.name,
        error: msg,
        ts: Date.now(),
      };
      throw new Error(msg);
    }
    // External script / command (`run`). Pipe the upstream output to the
    // process's stdin and use its stdout as this phase's output; a non-zero
    // exit is a phase error. Same trust model as `source` (an inline snippet
    // can already reach the host) — this is just the ergonomic,
    // language-agnostic form. `child_process` is imported lazily so the
    // executor stays bundleable for non-Node surfaces.
    //
    // Interpolate `${...}` against run state first so a command can reference
    // `${vars.scriptsDir}/build.sh`, an upstream `${as}` value, or `${item}` /
    // `${index}` inside a map — without this, the only way to parameterize a
    // script was the stdin pipe, which the verbatim string couldn't express.
    // Values come from already-host-trusted run state, matching code.run's
    // existing "can reach the host" trust model.
    const command = resolveCommand(node.code!.run, lookupState(ctx, input));
    // Enforce the sandbox denylist on the RESOLVED command (post-interpolation,
    // so an injected `${...}` value can't smuggle a denied substring past the
    // gate). Mirrors the agent Bash-tool path; a blocked command is a phase
    // failure that routes through retry / onError like any other.
    const denied = checkDeniedCommand(command, sandbox);
    if (denied) {
      const msg = `code.run blocked by sandbox denylist: command contains "${denied}"`;
      yield { type: 'phase-error', phaseName: node.name, error: msg, ts: Date.now() };
      throw new Error(msg);
    }
    // ALLOWLIST mode: the resolved command must match a pattern, and runs
    // WITHOUT a shell (argv split, no expansion) — see code-run-policy.ts.
    let argv: string[] | null = null;
    if (runMode === 'allowlist') {
      const patterns = codeRunAllowlist();
      if (!matchAllowlist(command, patterns)) {
        const msg =
          `code.run command is not in SAMMY_CODE_RUN_ALLOW: "${command.slice(0, 300)}" ` +
          `(allowed: ${patterns.join(' ; ')})`;
        yield { type: 'phase-error', phaseName: node.name, error: msg, ts: Date.now() };
        throw new Error(msg);
      }
      try {
        argv = splitArgv(command);
      } catch (err) {
        const msg = `code.run command could not be parsed: ${(err as Error).message}`;
        yield { type: 'phase-error', phaseName: node.name, error: msg, ts: Date.now() };
        throw new Error(msg);
      }
      if (argv.length === 0) {
        const msg = 'code.run command is empty';
        yield { type: 'phase-error', phaseName: node.name, error: msg, ts: Date.now() };
        throw new Error(msg);
      }
    }
    if (ctx.cancelled.v) throw new RunCancelled();
    // Resolve child_process WITHOUT an import statement: the executor is
    // bundled for the browser too (EvalsPage imports runOrchestration), and
    // jest's VM rejects dynamic import. `process.getBuiltinModule` is a
    // runtime lookup the bundler ignores; code.run only runs on a Node
    // server / CLI surface anyway.
    type SpawnedChild = {
      stdout: { on(e: 'data', cb: (d: unknown) => void): void } | null;
      stderr: { on(e: 'data', cb: (d: unknown) => void): void } | null;
      stdin: {
        write(s: string): void;
        end(): void;
        // Optional so a minimal spawn stub (parity recording harness)
        // without an event emitter still satisfies the shape.
        on?(ev: string, cb: (...a: unknown[]) => void): void;
      } | null;
      on(e: string, cb: (...args: unknown[]) => void): void;
      // Optional for the same minimal stubs; a real child has both.
      pid?: number;
      kill?(sig?: NodeJS.Signals): boolean;
    };
    const getBuiltin = (
      globalThis.process as unknown as {
        getBuiltinModule?: (id: string) => unknown;
      }
    ).getBuiltinModule;
    const spawn = (
      getBuiltin?.('node:child_process') as
        | {
            spawn?: (
              cmd: string,
              argsOrOpts:
                | string[]
                | {
                    shell: boolean;
                    signal: AbortSignal;
                    cwd?: string;
                    env?: Record<string, string | undefined>;
                  },
              opts?: {
                shell: boolean;
                signal: AbortSignal;
                cwd?: string;
                env?: Record<string, string | undefined>;
              },
            ) => SpawnedChild;
          }
        | undefined
    )?.spawn;
    if (!spawn) {
      yield {
        type: 'phase-error',
        phaseName: node.name,
        error:
          'code.run requires a Node runtime (child_process unavailable on this surface)',
        ts: Date.now(),
      };
      throw new Error('code.run unsupported on this surface');
    }
    // Run the child in an isolated temp working directory rather than
    // inheriting the server's cwd. A spawned tool that writes a RELATIVE
    // artifact (a screenshot, a scratch file) would otherwise litter it into
    // whatever directory the server happens to run from — often a source repo.
    // Giving each code.run its own throwaway cwd keeps those artifacts out of
    // tracked trees. Best-effort + domain-pure: any failure here (no fs / no
    // os) just falls back to the inherited cwd. The dir is left for the OS temp
    // sweeper — cheap, and useful for post-hoc inspection of what a child wrote.
    // A run with exactly one worktree runs its commands THERE (that is the
    // point of the worktree — `npx jest` must see the repository). `code.cwd`
    // picks a directory explicitly — only inside one of the run's worktrees.
    let runCwd: string | undefined = ctx.defaultCwd;
    if (typeof node.code!.cwd === 'string' && node.code!.cwd !== '') {
      const pathMod = getBuiltin?.('node:path') as
        | { resolve: (...p: string[]) => string; relative: (a: string, b: string) => string; isAbsolute: (p: string) => boolean }
        | undefined;
      const fsMod = getBuiltin?.('node:fs') as { realpathSync?: (p: string) => string } | undefined;
      // Compare REAL paths: a symlink inside the worktree must not lead out.
      const real = (p: string): string | null => {
        try {
          return fsMod?.realpathSync ? fsMod.realpathSync(p) : p;
        } catch {
          return null;
        }
      };
      const wanted = interpolate(node.code!.cwd, lookupState(ctx, input));
      const roots = Object.values(ctx.worktreeEnv);
      // With several worktrees a relative path has no obvious anchor —
      // resolving it against "the first one" surprised the author.
      if (roots.length > 1 && pathMod && !pathMod.isAbsolute(wanted)) {
        const msg =
          `code.cwd "${wanted}" is relative, but this run declares ${roots.length} worktrees — ` +
          'start it with ${worktrees.<name>.path}';
        yield { type: 'phase-error', phaseName: node.name, error: msg, ts: Date.now() };
        throw new Error(msg);
      }
      const resolvedCwd = pathMod
        ? real(pathMod.resolve(ctx.defaultCwd ?? roots[0] ?? '.', wanted))
        : null;
      const inside =
        !!pathMod &&
        resolvedCwd !== null &&
        roots.some(r => {
          const rr = real(r);
          if (!rr) return false;
          const rel = pathMod.relative(rr, resolvedCwd);
          return rel === '' || (!rel.startsWith('..') && !pathMod.isAbsolute(rel));
        });
      if (!inside) {
        const msg =
          `code.cwd "${wanted}" is not inside one of this run's worktrees` +
          (roots.length === 0 ? ' (the orchestration declares none)' : '');
        yield { type: 'phase-error', phaseName: node.name, error: msg, ts: Date.now() };
        throw new Error(msg);
      }
      runCwd = resolvedCwd!;
    }
    if (!runCwd) try {
      const os = getBuiltin?.('node:os') as
        | { tmpdir?: () => string }
        | undefined;
      const fs = getBuiltin?.('node:fs') as
        | { mkdtempSync?: (prefix: string) => string }
        | undefined;
      const pathMod = getBuiltin?.('node:path') as
        | { join?: (...parts: string[]) => string }
        | undefined;
      const tmp = os?.tmpdir?.();
      if (tmp && fs?.mkdtempSync && pathMod?.join) {
        runCwd = fs.mkdtempSync(pathMod.join(tmp, 'sammy-coderun-'));
      }
    } catch {
      /* no temp dir — fall back to the inherited cwd */
    }
    const ac = new AbortController();
    // The child enforces its OWN wallclock and silence limits. The generic
    // `withTimeout` / stall backstops end a phase by calling the generator's
    // `return()`, which cannot run while this loop is parked on the child's
    // next chunk — so without this a `timeout: 60` step running `sleep 3600`
    // held the run for the full hour, and its artifact was never written.
    // Killed a hair BEFORE the backstop so the kill (and its log) wins.
    const codeLimits = resolveNodeLimits(node, ctx.orchestrationDefaults);
    const killAfterMs =
      Math.max(0.05, (codeLimits.timeout ?? envSeconds('SAMMY_DEFAULT_NODE_TIMEOUT_SEC', DEFAULT_NODE_TIMEOUT_SEC)) - 0.1) *
      1000;
    const silenceMs =
      (codeLimits.stallTimeout ?? envSeconds('SAMMY_DEFAULT_STALL_TIMEOUT_SEC', DEFAULT_STALL_TIMEOUT_SEC)) * 1000 - 100;
    const childStartedAt = Date.now();
    let lastChildActivity = childStartedAt;
    // The kill raises the SAME error the backstop would have — a StallError
    // still routes to `onStall` recovery, a TimeoutError to retry / onError.
    let killedWith: Error | null = null;
    let killedFor: string | null = null;
    const poll = setInterval(() => {
      if (ctx.cancelled.v) ac.abort();
      else if (!killedFor && Date.now() - childStartedAt >= killAfterMs) {
        const sec = codeLimits.timeout ?? envSeconds('SAMMY_DEFAULT_NODE_TIMEOUT_SEC', DEFAULT_NODE_TIMEOUT_SEC);
        killedFor = `timed out after ${sec}s`;
        killedWith = new TimeoutError(sec, { nodeName: node.name, defaulted: codeLimits.timeout == null });
        ac.abort();
      } else if (!killedFor && Date.now() - lastChildActivity >= silenceMs) {
        const sec = Math.round((silenceMs + 100) / 1000);
        killedFor = `no output on stdout or stderr for ${sec}s (stall)`;
        killedWith = new StallError(node.name, sec);
        ac.abort();
      }
    }, 50);
    // Stream the child's stdout as it arrives instead of only buffering it.
    // Each chunk is yielded as a `phase-delta` progress event, which serves a
    // double purpose: it surfaces the drive's output live in the UI, AND it
    // gives the stall watchdog a real heartbeat — a running-but-quiet child
    // that prints periodically resets the stall timer, while a truly wedged one
    // (no output) trips it. We still accumulate the full stdout for the phase
    // output / contract check below (unchanged behavior).
    let out = '';
    let errOut = '';
    const chunks: string[] = [];
    let closed = false;
    let closeErr: Error | null = null;
    // A promise the drain loop awaits, resolved on each new chunk or on close.
    // Lets the generator block without busy-waiting yet wake immediately on
    // activity (so progress events flow in near-real-time). The loop creates a
    // FRESH promise at the top of every iteration BEFORE it drains/checks state,
    // so a signal that lands while it's draining still resolves the promise it's
    // about to await — no lost wakeups (which would otherwise delay a heartbeat
    // and could false-trip the stall watchdog).
    let wake: (() => void) | undefined;
    const signal = () => { wake?.(); };
    // Its own process group (POSIX), so a kill reaches the WHOLE command:
    // `sh -c 'a; b'` under dash (Linux's /bin/sh) forks `b` instead of
    // exec'ing it, and a signal to the shell alone left `b` running forever
    // after a timeout — holding the server's pipes open. See killTree.
    const ownGroup = process.platform !== 'win32';
    const spawnOpts = {
      shell: argv === null,
      signal: ac.signal,
      detached: ownGroup,
      ...(runCwd ? { cwd: runCwd } : {}),
      // The whole server environment by default; only the base set + the
      // names in SAMMY_CODE_RUN_ENV when that is set (a test that dumps its
      // environment then has nothing secret to dump). Worktree paths always.
      ...(Object.keys(ctx.worktreeEnv).length > 0 || codeRunEnvAllowlist() !== null
        ? { env: codeRunChildEnv(ctx.worktreeEnv) }
        : {}),
    };
    const child =
      argv === null ? spawn(command, spawnOpts) : spawn(argv[0], argv.slice(1), spawnOpts);
    const killTree = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (ownGroup) process.kill(-child.pid, sig);
        else child.kill?.(sig);
      } catch {
        /* already gone */
      }
    };
    ac.signal.addEventListener(
      'abort',
      () => {
        killTree('SIGTERM');
        const hard = setTimeout(() => killTree('SIGKILL'), 2_000);
        (hard as { unref?: () => void }).unref?.();
      },
      { once: true },
    );
    // `code.artifact`: keep the whole command log (bounded tail) as a named
    // run artifact — on failure as much as on success, since a failing
    // reproduction's output is the evidence worth attaching to a ticket.
    const artifactName =
      typeof node.code!.artifact === 'string' && node.code!.artifact.trim()
        ? node.code!.artifact.trim()
        : null;
    const emitArtifact = (exit: string): RunEvent | null => {
      if (!artifactName) return null;
      const cap = envSeconds('SAMMY_ARTIFACT_MAX_BYTES', DEFAULT_ARTIFACT_MAX_BYTES);
      // SCRUB FIRST, then trim: trimming first could cut a secret in half,
      // and a half-secret no longer matches the scrubber.
      let content = scrubSecrets(
        `$ ${command}\n` +
          (out ? `--- stdout ---\n${out}${out.endsWith('\n') ? '' : '\n'}` : '') +
          (errOut ? `--- stderr ---\n${errOut}${errOut.endsWith('\n') ? '' : '\n'}` : '') +
          `[${exit}]\n`,
        ctx.injectedSecrets,
      );
      let truncated = false;
      if (content.length > cap) {
        content = `…(truncated)\n${content.slice(-cap)}`;
        truncated = true;
      }
      // A run-wide budget, so a map / loop of artifact steps cannot grow the
      // event log without bound (each artifact is an event every read loads).
      const runCap = envSeconds('SAMMY_ARTIFACT_RUN_MAX_BYTES', DEFAULT_ARTIFACT_RUN_MAX_BYTES);
      let dropped = false;
      if (ctx.artifactBytes.v + content.length > runCap) {
        content = `(artifact dropped: this run's artifact budget of ${runCap} bytes is spent — SAMMY_ARTIFACT_RUN_MAX_BYTES)\n`;
        truncated = true;
        dropped = true;
      }
      ctx.artifactBytes.v += content.length;
      const scopedName = replayKeyFor(ctx, artifactName);
      ctx.artifactsByName.set(scopedName, { text: content, mediaType: 'text/plain', dropped });
      return {
        type: 'artifact',
        phaseName: node.name,
        // Scoped like a checkpoint key, so each map item / loop iteration's
        // artifact is fetchable on its own (`<map>[2]/repro-log`).
        name: scopedName,
        mediaType: 'text/plain',
        content,
        bytes:
          typeof TextEncoder !== 'undefined'
            ? new TextEncoder().encode(content).length
            : content.length,
        truncated,
        ...(dropped ? { dropped: true } : {}),
        replayKey: replayKeyFor(ctx, node.name),
        ts: Date.now(),
      };
    };
    let exitLabel = 'exit 0';
    child.stdout?.on('data', (d) => {
      const s = (d as { toString(): string }).toString();
      lastChildActivity = Date.now();
      out += s;
      chunks.push(s);
      signal();
    });
    // stderr is activity too (jest / mvn report progress there) — surfaced as
    // a heartbeat so the OUTER stall watchdog agrees with the kill above.
    let stderrSinceBeat = 0;
    let lastStderrBeat = 0;
    const stderrBeatMs = Math.min(15_000, Math.max(200, (silenceMs + 100) / 4));
    child.stderr?.on('data', (d) => {
      lastChildActivity = Date.now();
      const t = (d as { toString(): string }).toString();
      errOut += t;
      stderrSinceBeat += t.length;
      signal();
    });
    child.on('error', (e) => { closeErr = e as Error; closed = true; signal(); });
    child.on('close', (code) => {
      const c = code as number | null;
      exitLabel = c === null ? 'killed' : `exit ${c}`;
      if (c !== 0) {
        // Surface WHY it failed, not just the exit code. The actionable
        // diagnostic for a shell tool is its stderr (and, when stderr is
        // empty, the tail of stdout) — without it the operator only sees
        // "script exited with code N" and has to re-run by hand to find out
        // what broke. Keep the TAIL of each stream (errors land at the end),
        // bounded so a flood-on-failure can't blow up the event log. Labeled
        // so the two streams are distinguishable in the message.
        const tail = (s: string): string =>
          s.length > CODE_RUN_DIAG_TAIL_BYTES
            ? `…${s.slice(-CODE_RUN_DIAG_TAIL_BYTES)}`
            : s;
        const parts: string[] = [];
        const errTail = tail(errOut.trimEnd());
        const outTail = tail(out.trimEnd());
        if (errTail) parts.push(`stderr: ${errTail}`);
        // Include a stdout tail too — many tools print the real failure to
        // stdout. Always show it when stderr was empty; otherwise append it as
        // secondary context so a stderr-only message isn't the whole story.
        if (outTail) parts.push(`stdout (tail): ${outTail}`);
        const detail = parts.length > 0 ? `\n${parts.join('\n')}` : '';
        closeErr = new Error(`script exited with code ${c}${detail}`);
      }
      closed = true;
      signal();
    });
    // A script that doesn't read stdin may close the pipe before (or while)
    // we write. The failure arrives BOTH ways: synchronously (caught here)
    // and asynchronously as a stream 'error' event (EPIPE) — which, without
    // a listener, is an uncaught exception that kills the phase. Seen on
    // slow 2-core CI runners where the child wins the race routinely.
    // Either way the script's stdout/exit-code still decide the outcome.
    // The attach lives INSIDE the try and uses an optional call: a minimal
    // spawn stub (the preview-parity recording harness) has no stdin.on,
    // and a throw HERE would skip the drain loop's finally — leaking the
    // ref'd cancel-poll interval above (a held event loop; found as a CI
    // exit-hang).
    try {
      child.stdin?.on?.('error', () => {
        /* pipe closed early — benign; outcome comes from stdout/exit code */
      });
      child.stdin?.write(input);
      child.stdin?.end();
    } catch {
      /* a script that doesn't read stdin may close the pipe early */
    }
    try {
      // Drain loop: flush any buffered stdout as progress events, then await
      // the next chunk / close. Exits when the child has closed AND the chunk
      // buffer is empty.
      for (;;) {
        // Arm the wake promise BEFORE draining, so any chunk/close that arrives
        // mid-drain resolves THIS promise rather than being lost.
        const wakePromise = new Promise<void>((r) => { wake = r; });
        while (chunks.length > 0) {
          const text = chunks.shift()!;
          yield { type: 'phase-delta', phaseName: node.name, text, ts: Date.now() };
        }
        // Throttled like the SDK's own heartbeats: often enough to keep the
        // stall watchdog fed (a few per stall window), never one per chunk —
        // a chatty jest run would otherwise add thousands of event rows.
        if (stderrSinceBeat > 0 && Date.now() - lastStderrBeat >= stderrBeatMs) {
          lastStderrBeat = Date.now();
          const bytes = stderrSinceBeat;
          stderrSinceBeat = 0;
          yield {
            type: 'phase-heartbeat',
            phaseName: node.name,
            via: 'stderr',
            messages: 0,
            toolUses: 0,
            textBytes: bytes,
            ts: Date.now(),
          };
        }
        if (closed) break;
        if (ctx.cancelled.v) ac.abort();
        await wakePromise;
      }
      if (killedWith) throw killedWith;
      if (closeErr) throw closeErr;
      result = out;
    } catch (err) {
      clearInterval(poll);
      if (!closed) ac.abort();
      if (ctx.cancelled.v) throw new RunCancelled();
      // A stall kill reports itself exactly like the watchdog would, so the
      // run viewer's stall marker and the degradation reason are unchanged.
      // (Assigned inside the poll callback, so TS narrows it to null here.)
      const kill = killedWith as Error | null;
      if (kill instanceof StallError) {
        yield {
          type: 'node-stalled',
          phaseName: node.name,
          stallSeconds: kill.stallSeconds,
          ts: Date.now(),
        };
      }
      const art = emitArtifact(
        killedFor
          ? `killed: ${killedFor}`
          : exitLabel === 'exit 0'
            ? `failed: ${(err as Error).message.split('\n')[0]}`
            : exitLabel,
      );
      if (art) yield art;
      yield {
        type: 'phase-error',
        phaseName: node.name,
        error: `code script failed: ${(err as Error).message}`,
        ts: Date.now(),
      };
      throw err;
    } finally {
      // Ended from OUTSIDE (the phase backstop or a cancel calling the
      // generator's return() while it waits on the child): neither branch
      // above ran, so stop the command here or it outlives the phase.
      if (!closed) {
        clearInterval(poll);
        ac.abort();
      }
    }
    clearInterval(poll);
    {
      const art = emitArtifact(exitLabel);
      if (art) yield art;
    }
  } else {
    const source = node.code!.source ?? '';
    const timeoutMs = Math.max(1, Math.floor(maxRunSeconds * 1000));
    try {
      const vm = getVm();
      if (vm) {
        // Fresh context: its global has ONLY these + the JS built-ins
        // (JSON/Math/Date/Promise). No process / require / fetch / setTimeout
        // → no ambient I/O; an accidental `fetch(...)` throws instead of
        // silently reaching the network.
        const context = vm.createContext({
          input,
          state: ctx.state,
          item,
          index,
          vars,
        });
        const script = new vm.Script(
          `"use strict";(async()=>{\n${source}\n})()`,
          { filename: 'code-node.js' },
        );
        // vm `timeout` interrupts a SYNCHRONOUS busy-loop (throws right here —
        // the case a phase `timeout` can't catch because it blocks the loop).
        const started = script.runInContext(context, { timeout: timeoutMs });
        // Host-side race bounds an ASYNC hang (a never-resolving promise): the
        // synchronous part has already returned, so this timer can fire.
        let asyncTimer: ReturnType<typeof setTimeout> | undefined;
        const race = new Promise<never>((_, reject) => {
          asyncTimer = setTimeout(
            () => reject(new Error(`code exceeded ${maxRunSeconds}s`)),
            timeoutMs,
          );
          (asyncTimer as unknown as { unref?: () => void }).unref?.();
        });
        try {
          result = await Promise.race([Promise.resolve(started), race]);
        } finally {
          if (asyncTimer) clearTimeout(asyncTimer);
        }
      } else {
        // Non-Node surface (browser bundle): no ambient host to remove and no
        // vm available; fall back to Function. The server/CLI path — where the
        // risk actually lives — always has vm.
        // eslint-disable-next-line no-new-func
        const fn = new Function(
          'input',
          'state',
          'item',
          'index',
          'vars',
          `"use strict"; return (async () => { ${source} })();`,
        ) as (
          input: string,
          state: State,
          item: unknown,
          index: unknown,
          vars: Record<string, unknown>,
        ) => Promise<unknown>;
        result = await fn(input, ctx.state, item, index, vars);
      }
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      yield {
        type: 'phase-error',
        phaseName: node.name,
        error: `code phase threw: ${message}`,
        ts: Date.now(),
      };
      throw err;
    }
  }

  // Stringify non-string results so the downstream input is always a
  // string (consistent with agent-phase outputs). `undefined` becomes
  // empty string.
  const output =
    typeof result === 'string'
      ? result
      : result === undefined
        ? ''
        : JSON.stringify(result);

  // Output size cap (sandbox) — a transform can't flood the pipeline.
  const outBytes =
    typeof TextEncoder !== 'undefined'
      ? new TextEncoder().encode(output).length
      : output.length;
  if (outBytes > maxOutputBytes) {
    const msg = `code output ${outBytes}B exceeds sandbox cap ${maxOutputBytes}B`;
    yield {
      type: 'phase-error',
      phaseName: node.name,
      error: msg,
      ts: Date.now(),
    };
    throw new Error(msg);
  }

  // Output contract enforcement — same as runAgentPhase.
  const outCheck = checkContract(node.output, output);
  if (outCheck.enforce && !outCheck.ok) {
    throw new Error(`Phase "${node.name}" ${outCheck.reason}`);
  }

  ctx.lastOutput = output;
  yield {
    type: 'phase-end',
    phaseName: node.name,
    output,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: Date.now() - startMs,
    model: 'code',
    replayKey,
    ts: Date.now(),
  };
  // LIVE CHECKPOINT — same contract (and same deliberate AFTER-the-yield
  // ordering) as runAgentPhase: a completed code leaf replays on any
  // in-process re-run of an enclosing composite (retry / onStall) instead of
  // re-executing its transform / shell command — but a watchdog-aborted leaf
  // whose yield was swallowed (e.g. a code.run child that finished late,
  // after the stall guard already gave up on it) must NOT checkpoint.
  ctx.replayOutputs.set(replayKey, output);
}

/** Wrap an async iterable so the whole thing errors out after `seconds`.
 *  We race each `.next()` against the deadline so we can fail mid-stream.
 *
 *  Teardown: the inner iterator's `.return()` is ALWAYS driven on abnormal
 *  exit — the deadline throw, OR a downstream `.return()` (e.g. an outer
 *  stall-guard abandoning us) — via the `finally`. Without this, an outer
 *  wrapper that `.return()`s this generator would abandon our manual loop
 *  WITHOUT propagating to `inner`, orphaning the underlying dispatch (a leaked
 *  agent slot + an unclosed SDK stream). `endedNormally` skips the redundant
 *  return when the inner already completed on its own. */
async function* withTimeout<T>(
  iter: AsyncIterable<T>,
  seconds: number,
  errOpts?: { nodeName?: string; defaulted?: boolean },
): AsyncIterable<T> {
  const deadline = Date.now() + seconds * 1000;
  const inner = iter[Symbol.asyncIterator]();
  let endedNormally = false;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TimeoutError(seconds, errOpts);
      const next = inner.next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ timeout: true }>(resolve => {
        timer = setTimeout(() => resolve({ timeout: true }), remaining);
        (timer as unknown as { unref?: () => void }).unref?.();
      });
      let result: IteratorResult<T> | { timeout: true };
      try {
        result = await Promise.race([next, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if ('timeout' in result) throw new TimeoutError(seconds, errOpts);
      if (result.done) { endedNormally = true; return; }
      yield result.value;
    }
  } finally {
    if (!endedNormally) {
      try { await inner.return?.(undefined); } catch { /* ignore */ }
    }
  }
}

/** Stall watchdog. Wraps a RunEvent stream and aborts it after `stallSeconds`
 *  of NO yielded events — but the timer RESETS on every event, so progress
 *  keeps it alive indefinitely. This is the no-progress complement to
 *  withTimeout's fixed wallclock cap: a slow-but-streaming node (long agent,
 *  running drive) is never false-flagged, while a silently-wedged one is
 *  caught even when far under its hard timeout.
 *
 *  CORRECTNESS: the reset is driven by REAL downstream events only (each
 *  `.next()` that produces a value), never a blind timer — so "progress" means
 *  the node actually emitted something. This relies on long nodes emitting
 *  heartbeats: agent nodes stream tokens as phase-delta events, and code.run
 *  streams child stdout as phase-delta events (see runCodePhase). A node that
 *  legitimately emits nothing for a long stretch should raise its
 *  `stallTimeout`.
 *
 *  Before throwing, it yields a `node-stalled` event so the stall is visible in
 *  the UI/logs; the thrown StallError then flows into the existing retry /
 *  onError recovery path. */
async function* withStallGuard(
  iter: AsyncIterable<RunEvent>,
  phaseName: string,
  stallSeconds: number,
): AsyncIterable<RunEvent> {
  const inner = iter[Symbol.asyncIterator]();
  const stallMs = stallSeconds * 1000;
  // Tracks whether `inner` still needs tearing down in the `finally`. Cleared
  // once we've already driven it to completion (stall return, or its own done)
  // so we never double-return; left true if we exit abnormally (a throw, or a
  // downstream `.return()` abandoning us) so the inner dispatch — and its agent
  // slot + SDK stream — is always released.
  let needsReturn = true;
  try {
    while (true) {
      const next = inner.next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stall = new Promise<{ stalled: true }>((resolve) => {
        timer = setTimeout(() => resolve({ stalled: true }), stallMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      });
      let result: IteratorResult<RunEvent> | { stalled: true };
      try {
        result = await Promise.race([next, stall]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if ('stalled' in result) {
        needsReturn = false;
        try { await inner.return?.(undefined); } catch { /* ignore */ }
        yield { type: 'node-stalled', phaseName, stallSeconds, ts: Date.now() };
        throw new StallError(phaseName, stallSeconds);
      }
      if (result.done) { needsReturn = false; return; }
      // A real event — progress. The next loop iteration creates a fresh timer,
      // so the stall window restarts from now.
      yield result.value;
    }
  } finally {
    if (needsReturn) {
      try { await inner.return?.(undefined); } catch { /* ignore */ }
    }
  }
}

/** Largest `stallTimeout` (seconds) declared anywhere in a node's subtree,
 *  or undefined if none. Used so a COMPOSITE / SUBFLOW node's own stall
 *  watchdog never trips earlier than its longest-stalling child would: a
 *  parent's window is widened to max(its own, the deepest child's) so a
 *  legitimately long-but-quiet leaf inside it (which has set a generous
 *  per-node `stallTimeout`) can run to its own deadline instead of being
 *  aborted by the parent's default ~420s no-progress guard (the 3 AM
 *  preflight regression).
 *
 *  Recurses every static composite via the shared `childNodesOf` walker
 *  (phases / parallel / converge / loop.body / map.body / route+switch
 *  branches+default / onError / onStall.recover — the recover phase's events
 *  bubble through the enclosing composite's guard too, so a generous
 *  `stallTimeout` declared inside it must widen the parent's window the same
 *  way an onError branch's does). For a `subflow` node it additionally
 *  resolves the referenced orchestration by name (via `orchestrationByName`)
 *  and walks ITS tree too — the subflow's body is a runtime reference,
 *  invisible to the static walker. Cycle-safe via `seen` (a subflow chain that
 *  loops back is not re-descended), so it terminates even on a circular
 *  composition; the executor's own cycle guard still refuses such a run at
 *  dispatch.
 *
 *  Pure + side-effect-free: it only READS the node tree and the registry. */
function maxStallTimeoutInSubtree(
  node: Node,
  orchestrationByName: Map<string, Node>,
  seen: Set<string> = new Set(),
): number | undefined {
  let max: number | undefined =
    typeof node.stallTimeout === 'number' && node.stallTimeout > 0
      ? node.stallTimeout
      : undefined;
  const consider = (child: Node | undefined): void => {
    if (!child) return;
    const childMax = maxStallTimeoutInSubtree(child, orchestrationByName, seen);
    if (childMax != null && (max == null || childMax > max)) max = childMax;
  };

  for (const child of childNodesOf(node)) consider(child);

  // Subflow: descend into the referenced orchestration's tree so a long child
  // declared inside the inlined flow widens this node's window too. Resolve the
  // bare name only — an unresolvable `${...}` ref (state-dependent) is simply
  // skipped here; it still gets its own guard once dispatched.
  if (typeof node.subflow === 'string' && !node.subflow.includes('${')) {
    if (!seen.has(node.subflow)) {
      seen.add(node.subflow);
      const sub = orchestrationByName.get(node.subflow);
      if (sub) consider(sub);
    }
  }

  return max;
}

function backoffDelay(retry: { initialMs?: number; backoff?: string }, attempt: number): number {
  const initial = retry.initialMs ?? 500;
  if (retry.backoff === 'exponential') return initial * Math.pow(2, attempt);
  return initial;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Decorator wrapper: applies when / lock / budget / retry / timeout / onError / as
 * around `dispatchNode`. This is the public entry — everywhere that recurses
 * into a child should call this, not `dispatchNode` directly.
 */
async function* executeNode(
  node: Node,
  ctx: ExecutorContext,
  input: string,
): AsyncIterable<RunEvent> {
  if (ctx.cancelled.v) throw new RunCancelled();

  // Clear any structured output left by a previous node so this node's `as`
  // block only sees a value its OWN dispatch produced (see lastOutputValue).
  ctx.lastOutputValue = undefined;

  // 1. `when` — skip if false; lastOutput preserved. `evalWhen` is the shared
  //    predicate (returns true to run) that preview also calls.
  //
  //    FAIL-LOUD on an unresolved predicate: interpolation leaves an unbound
  //    `${ref}` as the literal string, which is non-empty and therefore
  //    TRUTHY — so a `when: "${flagNobodySets}"` guard silently ALWAYS ran
  //    (the top silent intent/reality divergence: a typo'd or never-set flag
  //    turned a conditional phase into an unconditional one, with zero
  //    signal). New semantics: any `${ref}` in the predicate that does not
  //    resolve against run state makes the node SKIP, loudly — an
  //    `interpolation-unresolved` event names the refs, and the
  //    `phase-skipped` reason says the skip is the fail-safe interpretation.
  //    Skipping (not running) is the safe default for a guard whose condition
  //    is unknowable; a predicate that RESOLVES falsy still skips quietly with
  //    the classic reason, and `${item}` / `${index}` inside a map body (or
  //    any scope-local var) resolve via the lookup exactly as before.
  if (node.when !== undefined) {
    const unresolvedWhenRefs = new Set<string>();
    const whenTrue = evalWhen(node.when, lookupState(ctx, input), r =>
      unresolvedWhenRefs.add(r),
    );
    if (unresolvedWhenRefs.size > 0) {
      const refs = [...unresolvedWhenRefs];
      yield {
        type: 'interpolation-unresolved',
        phaseName: node.name,
        refs,
        ts: Date.now(),
      };
      yield {
        type: 'phase-skipped',
        phaseName: node.name,
        reason:
          `when predicate references unresolved \${...}: ${refs.join(', ')} ` +
          `— treating as false (fail-safe skip)`,
        ts: Date.now(),
      };
      return;
    }
    if (!whenTrue) {
      yield {
        type: 'phase-skipped',
        phaseName: node.name,
        reason: `when predicate "${node.when}" is falsy`,
        ts: Date.now(),
      };
      return;
    }
  }

  // 2. `lock` — wait for human approval before entering. Auto-approve
  //    when this leaf is in ctx.autoApproveLocks — used by resume so the lock
  //    the user already approved (by clicking Resume / Approve) doesn't fire
  //    its gate again and re-pause the run forever.
  //
  //    SCOPE: the auto-approve is consumed for the CURRENT iteration ONLY,
  //    matched by either the scoped replay key (loop iteration / map item /
  //    subflow instance) or the bare phase name (resume seeds the bare
  //    `pausedFor`; unscoped leaves key on the name). On a hit we DELETE the
  //    matched entry, so the NEXT iteration of the same gated phase — a
  //    different replay key — finds nothing and re-gates. Without this, the
  //    first approve of a refinement-loop's lock skipped EVERY later iteration's
  //    gate, so the loop never re-paused for review.
  if (node.lock) {
    // Iteration-scoped key for THIS gate instance (see replayScope /
    // replayKeyFor). Equal to the bare name at the top level; inside a
    // loop/map/subflow body it carries the iteration scope so each crossing is
    // distinct (`<map>[<idx>]/<gate>`, `<loop>@<iter>/<gate>`). Emitted on the
    // lock-gate event so resume can build a per-iteration auto-approve set — a
    // gate repeated across map/loop iterations is then auto-approved one
    // instance at a time instead of collapsing onto one bare name (the
    // serial-map resume→re-pause loop). Also matched against the resume
    // auto-approve set here (scoped key first, bare-name fallback).
    const lockScopedKey = replayKeyFor(ctx, node.name);
    // Always emit the gate event first — the audit trail records that a human
    // gate was reached even when we auto-approve past it below.
    yield {
      type: 'lock-gate',
      phaseName: node.name,
      replayKey: lockScopedKey,
      ts: Date.now(),
    };
    if (ctx.autoApproveAllLocks) {
      // Unattended mode (orchestration-root `autoApproveLocks: true`): no human
      // is present to approve, so proceed WITHOUT calling `waitForApproval`
      // (which would block — and thus pause the run — forever in a cron run).
      // Warn so the operator sees in the logs that a human gate was bypassed
      // and which phase it guarded. Note: this is NOT the resume-scoped
      // per-iteration `autoApproveLocks` Set, so nothing is consumed here —
      // every iteration of a gated phase auto-approves under this flag.
      console.warn(
        `[sammy-pack] auto-approving lock gate for phase "${node.name}" ` +
          `(orchestration autoApproveLocks=true; unattended mode — no human approval requested).`,
      );
    } else {
      const matchedKey = ctx.autoApproveLocks.has(lockScopedKey)
        ? lockScopedKey
        : ctx.autoApproveLocks.has(node.name)
          ? node.name
          : null;
      if (matchedKey !== null) {
        // Consume so a subsequent iteration of this phase re-gates.
        ctx.autoApproveLocks.delete(matchedKey);
      } else {
        // Pause for human approval. The pause record (`pausedFor`) keeps the
        // bare display name — unchanged for the UI. The iteration identity
        // needed to auto-approve exactly THIS gate on resume travels via the
        // lock-gate event's `replayKey` (emitted above), which resume reads to
        // build its scoped auto-approve set — and is ALSO passed here as the
        // optional 2nd arg so an approval implementation can key on the gate
        // INSTANCE (e.g. scope an approve-with-message to this iteration)
        // without parsing events. Existing implementations ignore it.
        const approved = await ctx.waitForApproval(node.name, lockScopedKey);
        if (!approved) {
          ctx.cancelled.v = true;
          throw new RunCancelled();
        }
      }
    }
  }

  // 3. `budget` — push circuit breaker for the subtree.
  if (node.budget) {
    ctx.budgets.push({
      budget: node.budget,
      nodeName: node.name,
      tokensAtEntry: ctx.usage.totalInputTokens + ctx.usage.totalOutputTokens,
      costAtEntry: ctx.usage.totalCostUsd,
    });
  }

  // 4 + 5. retry + timeout — wrap the dispatch.
  const maxAttempts = (node.retry?.times ?? 0) + 1;
  let attemptError: Error | null = null;

  // 5b. onStall — recover-and-re-run on a stall watchdog firing. This is an
  //     OUTER loop around the retry/timeout/onError machinery, distinct from
  //     `retry` (re-attempt with no fix-up) and `onError` (replace the node with
  //     a recovery branch's output): when the stall watchdog aborts the node
  //     (StallError) and `onStall` is configured with retries remaining, we run
  //     the `onStall.recover` phase for its side effect, then RE-RUN the actual
  //     node. `onStall` OWNS the stall path — a StallError destined for recovery
  //     bypasses the inner retry/onError so it isn't consumed as a generic
  //     error (a node with both `onStall` and `onError` sends stalls to onStall
  //     and every OTHER failure to retry/onError). Only the stall watchdog
  //     triggers it; a hard timeout / generic error flows through retry/onError
  //     unchanged. maxStallRetries 0 (or no onStall) ⇒ a stall aborts exactly as
  //     before.
  const maxStallRetries = node.onStall
    ? Math.max(0, Math.floor(node.onStall.maxRetries ?? 1))
    : 0;
  // The total passes through the dispatch machinery: the initial run plus one
  // per allowed stall-recovery re-run.
  try {
   stallLoop: for (let stallAttempt = 0; ; stallAttempt++) {
    attemptError = null;
    /** Set when this dispatch stalled AND a recovery+re-run is available — so we
     *  skip retry/onError and route to the onStall handler below. */
    let pendingStall: StallError | null = null;
    /** Set when this dispatch failed TERMINALLY (do-not-retry marker). Skips
     *  every re-run path — inner retry, onStall recover-and-re-run — and goes
     *  straight to onError/throw with the failure surfaced. */
    let terminalFailed = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const inner = dispatchNode(node, ctx, input);
        // Two independent safety nets, composed inner→outer:
        //  1. Hard wallclock cap — EVERY node gets one. An explicit
        //     `node.timeout` wins; otherwise the generous default backstop, so
        //     nothing ever runs truly unbounded (root cause of silent hangs).
        //  2. Stall watchdog (outer) — aborts after `stallTimeout` of NO
        //     progress events, resetting on each event. Catches a node that
        //     goes silent long before its hard cap. The hard timeout's
        //     TimeoutError propagates OUT through the stall guard unchanged.
        // A node value wins; else the orchestration's `defaults`; else the env
        // / built-in backstop below. `resolveNodeLimits` applies only the first
        // two layers (node ?? defaults), leaving the env/default fallback here,
        // so a run with no `defaults` and no node value behaves exactly as before.
        const resolvedLimits = resolveNodeLimits(node, ctx.orchestrationDefaults);
        const hardTimeout = envSeconds(
          'SAMMY_DEFAULT_NODE_TIMEOUT_SEC',
          DEFAULT_NODE_TIMEOUT_SEC,
        );
        let stallSeconds =
          resolvedLimits.stallTimeout ??
          envSeconds('SAMMY_DEFAULT_STALL_TIMEOUT_SEC', DEFAULT_STALL_TIMEOUT_SEC);
        // Composite / subflow stall-window inheritance: a node that only wraps
        // children (it emits no work of its own — its events are its children's
        // events bubbling up) must not trip its no-progress guard before its
        // longest-stalling child would. So widen its window to the max of its
        // own resolved value and the largest `stallTimeout` declared anywhere in
        // its subtree (the inlined orchestration too, for `subflow`). A leaf
        // keeps exactly its own value. Only ever WIDENS — never shrinks a node's
        // configured/default window — so a deliberately-short parent timeout is
        // still honored when it already exceeds every child's.
        const isComposite = compositeKey(node) != null || !!node.subflow;
        if (isComposite) {
          const subtreeMax = maxStallTimeoutInSubtree(
            node,
            ctx.orchestrationByName,
          );
          if (subtreeMax != null && subtreeMax > stallSeconds) {
            stallSeconds = subtreeMax;
          }
        }
        const timeoutSec = resolvedLimits.timeout ?? hardTimeout;
        // Finalize-with-partials: for a FAN-OUT composite (map / parallel /
        // converge), thread the resolved hard deadline into the dispatch so its
        // drain can self-enforce it — emitting a `composite-partial` with the
        // already-completed children's outputs and returning cleanly, instead of
        // being torn down by the `withTimeout` backstop below (whose `.return()`
        // would block on a still-running child and discard everything). The
        // composite's own deadline is set to the FULL timeout; the backstop gets
        // a small grace margin (COMPOSITE_PARTIAL_GRACE_MS) so the composite's
        // partial path wins the race and the hard cap only fires if the composite
        // somehow fails to finalize. Subflow/phases sequences don't use this —
        // they finalize via the `finally`-phase + sequential-unwind paths.
        const partialKind = compositeKey(node);
        const supportsPartial =
          partialKind === 'map' ||
          partialKind === 'parallel' ||
          partialKind === 'converge';
        let backstopSec = timeoutSec;
        if (supportsPartial) {
          ctx.compositeDeadlineMs = Date.now() + timeoutSec * 1000;
          backstopSec = timeoutSec + COMPOSITE_PARTIAL_GRACE_MS / 1000;
        } else {
          ctx.compositeDeadlineMs = undefined;
        }
        const timed = withTimeout(inner, backstopSec, {
          nodeName: node.name,
          // "defaulted" = the author never chose this cap: no node
          // `timeout` and no root `defaults.timeout` — the error then
          // names the default and how to raise it.
          defaulted: resolvedLimits.timeout == null,
        });
        const wrapped = withStallGuard(timed, node.name, stallSeconds);
        for await (const ev of wrapped) yield ev;
        attemptError = null;
        break;
      } catch (err) {
        if (err instanceof RunCancelled || err instanceof RunPauseRequested) throw err;
        if (err instanceof BudgetExceededError) throw err; // budget breach is fatal, never retried
        // TERMINAL failure (anti-retry-storm): the phase declared its failure
        // do-not-retry (a TerminalPhaseError, or an agent that emitted a
        // `SAMMY-TERMINAL:` marker). Skip BOTH the inner retry re-attempts AND
        // onStall recovery — re-running fine work is exactly the storm we kill.
        // Emit `phase-terminal` so the log shows the suppression + how many
        // re-attempts were skipped, then leave the loop with attemptError set so
        // onError / throw handles it like any exhausted failure. A terminal
        // failure is still a FAILURE — onError / continueOnError (a different,
        // deliberate action) apply; only the REDO is suppressed.
        if (isTerminalFailure(err)) {
          attemptError = err as Error;
          const retriesSuppressed = maxAttempts - 1 - attempt;
          yield {
            type: 'phase-terminal',
            phaseName: node.name,
            reason: (err as TerminalPhaseError).reason ?? (err as Error).message,
            retriesSuppressed: Math.max(0, retriesSuppressed),
            ts: Date.now(),
          };
          terminalFailed = true;
          break;
        }
        // Stall destined for onStall recovery: bail out of the retry loop
        // WITHOUT recording a generic attemptError, so it skips onError and is
        // handled by the onStall block below (recover + re-run the whole node).
        if (
          err instanceof StallError &&
          node.onStall &&
          stallAttempt < maxStallRetries
        ) {
          pendingStall = err;
          break;
        }
        attemptError = err as Error;
        if (attempt < maxAttempts - 1) {
          const delayMs = backoffDelay(node.retry ?? {}, attempt);
          yield {
            type: 'node-retried',
            phaseName: node.name,
            attempt: attempt + 1,
            maxAttempts,
            error: attemptError.message,
            delayMs,
            ts: Date.now(),
          };
          await sleep(delayMs);
        }
      }
    }

    // 5b. onStall recovery — the dispatch stalled and a recovery+re-run is
    //     available. Run the `recover` phase (for its side effect — its output
    //     is NOT this node's output), then continue the outer loop to re-run the
    //     ACTUAL node. `${error.message}` (the stall message) is in scope inside
    //     the recovery phase, mirroring onError. A TERMINAL failure never gets
    //     here (the catch sets terminalFailed + attemptError and leaves
    //     pendingStall null) — guarded explicitly so the intent is unmissable.
    if (pendingStall && node.onStall && !terminalFailed) {
      const recoveryScope: State = {
        ...ctx.scope,
        error: { message: pendingStall.message },
      };
      // ATTEMPT-scoped replay keys for the recovery subtree. The recover
      // phase runs for its SIDE EFFECT (kill + relaunch a wedged dependency)
      // and may legitimately run once per stall attempt — but leaves now
      // live-checkpoint on success (see runAgentPhase), so under the parent
      // scope a SECOND stall's recovery would skip-replay the first recovery's
      // output and never actually perform the fix-up, wedging the re-run loop.
      // Scoping each attempt (`<node>~stall<N>/…`) keeps every recovery
      // execution a distinct checkpoint — genuinely re-running per attempt
      // in-process, and replaying per-attempt on resume.
      const recoveryCtx: ExecutorContext = {
        ...ctx,
        scope: recoveryScope,
        replayScope: `${replayKeyFor(ctx, node.name)}~stall${stallAttempt + 1}`,
      };
      yield {
        type: 'stall-recovery',
        phaseName: node.name,
        attempt: stallAttempt + 1,
        maxRetries: maxStallRetries,
        stallSeconds: pendingStall.stallSeconds,
        ts: Date.now(),
      };
      yield* executeNode(node.onStall.recover, recoveryCtx, input);
      // Re-run the stalled node on the next outer-loop pass.
      continue stallLoop;
    }

    // 6. onError — recovery branch if retries exhausted.
    if (attemptError) {
      if (node.onError) {
        const recoveryScope: State = {
          ...ctx.scope,
          error: { message: attemptError.message },
        };
        const recoveryCtx: ExecutorContext = { ...ctx, scope: recoveryScope };
        yield {
          type: 'node-recovered',
          phaseName: node.name,
          error: attemptError.message,
          ts: Date.now(),
        };
        yield* executeNode(node.onError, recoveryCtx, input);
        // recovery's lastOutput becomes this node's output (already on shared ctx)
      } else {
        throw attemptError;
      }
    }

    // Dispatch settled (success, retry-recovered, or onError-recovered) — no
    // stall recovery needed. Leave the outer onStall loop and proceed to `as` /
    // `halt`. (A stall with retries EXHAUSTED fell through to onError/throw
    // above, so it never reaches here as a pendingStall.)
    break stallLoop;
   }

    // 7. `as` — name this output for downstream `${name}` refs.
    //    When the key is declared in root `state` with a reducer,
    //    fold the new value into the slot instead of replacing it.
    if (applyAs(node, ctx)) {
      yield { type: 'state-set', key: node.as!, ts: Date.now() };
    }

    // 8. `halt` — end the run after this node. With `when`, it's a conditional
    //    early return: when-falsy skips the node above (no halt); when-truthy
    //    runs it and trips the flag every enclosing sequence checks, so the
    //    run ends here with this node's output. (A node that errored without
    //    recovery threw above and never reaches this.)
    if (node.halt) {
      ctx.halted.v = true;
      yield { type: 'run-halted', phaseName: node.name, ts: Date.now() };
    }
  } finally {
    if (node.budget) ctx.budgets.pop();
  }
}

/** `as` — store the node's output (ctx.lastOutput, or the structured value a
 *  dispatch left in ctx.lastOutputValue) under its name for downstream
 *  `${name}` refs, folding through the slot's reducer when root `state`
 *  declares one. Returns whether anything was stored. */
function applyAs(node: Node, ctx: ExecutorContext): boolean {
  if (!node.as) return false;
  // A structured value (e.g. a `map`'s per-item array) takes precedence
  // over the joined string so `${name}` resolves into the real value.
  const structured = ctx.lastOutputValue;
  ctx.lastOutputValue = undefined; // consume
  const decl = ctx.stateDecls[node.as];
  if (decl) {
    ctx.state[node.as] =
      structured !== undefined
        ? combineReducer(ctx.state[node.as], structured, decl.reducer)
        : applyReducer(ctx.state[node.as], ctx.lastOutput, decl.reducer);
  } else {
    ctx.state[node.as] =
      structured !== undefined ? structured : ctx.lastOutput;
  }
  return true;
}

/** Raw dispatch by node kind — no decorators here. Only ever called via
 *  `executeNode` so decorators stack correctly. */
async function* dispatchNode(
  node: Node,
  ctx: ExecutorContext,
  input: string,
): AsyncIterable<RunEvent> {
  // Subflow: inline another orchestration by name. State is SHARED with the
  // parent (matches parallel/converge semantics): the subflow can read
  // ${name} set upstream, and its own `as` writes propagate back up.
  // Cycles are detected and refused.
  if (node.subflow) {
    yield {
      type: 'composite-start',
      phaseName: node.name,
      kind: 'subflow',
      ts: Date.now(),
    };
    try {
      // Parameterization: the subflow name may reference state — e.g.
      // `subflow: "${component}-crawler"` — resolve it before the by-name
      // lookup (and before cycle detection, which then sees the real name).
      const subName = interpolate(node.subflow, lookupState(ctx, input));
      const subOrchestration = ctx.orchestrationByName.get(subName);
      if (!subOrchestration) {
        const available = Array.from(ctx.orchestrationByName.keys()).join(', ');
        yield {
          type: 'phase-error',
          phaseName: node.name,
          error:
            `subflow "${subName}" not found. Available orchestrations: ${available || '(none)'}`,
          ts: Date.now(),
        };
        throw new Error(`subflow "${subName}" not found`);
      }
      if (ctx.subflowStack.includes(subName)) {
        const chain = [...ctx.subflowStack, subName].join(' → ');
        yield {
          type: 'phase-error',
          phaseName: node.name,
          error: `circular subflow reference: ${chain}`,
          ts: Date.now(),
        };
        throw new Error(`circular subflow reference: ${chain}`);
      }
      ctx.subflowStack.push(subName);
      // Seed the referenced orchestration's OWN top-level `vars` (and `state`
      // initials) so its phases can interpolate `${theirVar}`. Without this,
      // composing an orchestration that declares its own vars silently
      // rendered them as empty placeholders. Seeded as DEFAULTS — a key the
      // parent already set wins, so an outer orchestration can still override.
      // State stays shared, so `${as}` writes inside the subflow remain
      // readable downstream (the existing compose-pipeline contract).
      const subSeed: State = { ...(subOrchestration.vars ?? {}) };
      for (const [k, decl] of Object.entries(subOrchestration.state ?? {})) {
        if (decl.initial !== undefined) subSeed[k] = decl.initial;
        else if (decl.reducer === 'append') subSeed[k] = [];
        else if (decl.reducer === 'merge') subSeed[k] = {};
        else if (decl.reducer === 'increment') subSeed[k] = 0;
      }
      for (const [k, v] of Object.entries(subSeed)) {
        if (!(k in ctx.state)) ctx.state[k] = v;
      }
      // Register the nested orchestration's sandbox policies. The run-start
      // walk (collectSandboxesInto) can't see inside a subflow — it's resolved
      // by name only here, at dispatch — so its leaves would otherwise be
      // absent from sandboxByPhase and fall to prompt-mode (a headless deny).
      // Seed them from THIS subflow node's effective policy so a
      // `bypassPermissions` (or tightening) declared on/above the subflow flows
      // into the nested leaves. Children still only tighten via mergeSandbox.
      collectSandboxesInto(
        subOrchestration,
        ctx.sandboxByPhase.get(node.name),
        ctx.sandboxByPhase,
      );
      try {
        // Instance-scoped replay keys: the sub-orchestration's leaves
        // checkpoint under `<subflow-node>/<name>`, so the same orchestration
        // inlined at two different nodes (or re-run inside a loop) keeps
        // distinct checkpoints. State stays shared with the parent (the
        // compose-pipeline contract) — only the replay scope is forked.
        const subCtx: ExecutorContext = {
          ...ctx,
          replayScope: replayKeyFor(ctx, node.name),
        };
        let cursorInput = input;
        const subPhases = subOrchestration.phases;
        if (Array.isArray(subPhases) && subPhases.length > 0) {
          for (const phase of subPhases) {
            yield* executeNode(phase, subCtx, cursorInput);
            cursorInput = subCtx.lastOutput;
          }
        } else {
          // The referenced orchestration's root is itself a body (a single
          // `map` / `parallel` / `converge` / `route` / `agent` / `code` / …),
          // not a `phases` sequence. Dispatch the root node directly so
          // composing such an orchestration runs its real body instead of
          // silently no-op'ing (the "subflow only runs phases" trap).
          yield* executeNode(subOrchestration, subCtx, cursorInput);
        }
        ctx.lastOutput = subCtx.lastOutput;
        // Carry up a structured output (e.g. a trailing `map`'s array) so the
        // subflow node's own `as` stores the real value, not the joined string.
        ctx.lastOutputValue = subCtx.lastOutputValue;
      } finally {
        ctx.subflowStack.pop();
      }
    } finally {
      yield {
        type: 'composite-end',
        phaseName: node.name,
        kind: 'subflow',
        ts: Date.now(),
      };
    }
    return;
  }

  // Leaf agent.
  if (node.agent) {
    yield* runAgentPhase(node, node.agent, ctx, input);
    return;
  }

  // Leaf: outbound A2A call to a remote agent.
  if (node.a2a) {
    yield* runA2aPhase(node, ctx, input);
    return;
  }

  // Leaf: inline JavaScript transform — no LLM call.
  if (node.code) {
    yield* runCodePhase(node, ctx, input);
    return;
  }

  // Leaf: durable timer / external-signal wait — no LLM call, zero cost
  // while parked.
  if (node.wait) {
    yield* runWaitPhase(node, ctx, input);
    return;
  }

  // Leaf: one HTTP request — no LLM call.
  if (node.http) {
    yield* runHttpPhase(node, ctx, input);
    return;
  }

  // Composite: serial agents inside one phase.
  if (Array.isArray(node.agents) && node.agents.length > 0) {
    yield { type: 'composite-start', phaseName: node.name, kind: 'agents', ts: Date.now() };
    try {
      let cursorInput = input;
      for (const agentPath of node.agents) {
        const name = agentPath.split('/').pop()?.replace(/\.md$/, '') ?? agentPath;
        const childNode: Node = { name: `${node.name}/${name}`, agent: agentPath };
        yield* runAgentPhase(childNode, agentPath, ctx, cursorInput);
        cursorInput = ctx.lastOutput;
      }
    } finally {
      yield { type: 'composite-end', phaseName: node.name, kind: 'agents', ts: Date.now() };
    }
    return;
  }

  // Composite: nested phases (serial).
  if (Array.isArray(node.phases) && node.phases.length > 0) {
    yield { type: 'composite-start', phaseName: node.name, kind: 'phases', ts: Date.now() };
    // Finalizer phases (`finally: true`) run AFTER the regular phases even when
    // the sequence is unwinding from an error — a try/finally for the sequence,
    // so aggregation / cleanup / triage always runs (e.g. collate + file a QA
    // sweep's findings when one leg timed out). Partition preserves declaration
    // order within each group. A sequence with no finalizers behaves exactly as
    // before — the finalizer loop is a no-op and the original error path is
    // unchanged.
    const regularPhases = node.phases.filter(p => p.finally !== true);
    const finalizerPhases = node.phases.filter(p => p.finally === true);
    // The error (if any) that unwound the regular sequence. Finalizers run
    // regardless; this is re-thrown AFTER them so a finalizer can't swallow the
    // real failure. Cancellation / pause / budget breaches bypass finalizers
    // entirely (see below) and never reach here.
    let unwindError: Error | null = null;
    try {
      let cursorInput = input;
      for (const child of regularPhases) {
        try {
          yield* executeNode(child, ctx, cursorInput);
        } catch (err) {
          // continueOnError: swallow + emit a phase-error event so the
          // run viewer surfaces the failure, then move on to the next
          // sibling instead of bubbling. RunCancelled / pause / budget
          // errors always bubble immediately AND skip finalizers — those are
          // user-/policy-initiated control-flow, not a sequence failure that
          // wants cleanup (cancel reaps via the run-controller; a pause
          // snapshots + resumes, so its finalizers must wait for the resume).
          if (err instanceof RunCancelled || err instanceof RunPauseRequested) throw err;
          if (err instanceof BudgetExceededError) throw err;
          if (child.continueOnError) {
            yield {
              type: 'phase-error',
              phaseName: child.name,
              error: (err as Error).message,
              ts: Date.now(),
            };
          } else {
            // A non-recoverable failure: stop the regular sequence, but still
            // run the finalizers below, then re-throw this original error.
            unwindError = err as Error;
            break;
          }
        }
        // A child carrying `halt` (or one deeper that tripped the flag)
        // stops this sequence — the rest of the regular phases don't run.
        // Finalizers below STILL run (cleanup/aggregation after a controlled
        // early return is exactly what they're for).
        if (ctx.halted.v) break;
        cursorInput = ctx.lastOutput;
      }

      // Finalizer phases — best-effort, always run (the sequence may be
      // unwinding from `unwindError` or a `halt`). Each goes through
      // `executeNode`, so it honors its OWN `timeout` / `stallTimeout` /
      // retry / onError. A finalizer's own failure is surfaced as a
      // phase-error but NEVER masks `unwindError` (the original error wins on
      // re-throw); only when there was no original error does a finalizer's
      // failure propagate. RunCancelled / pause / budget from a finalizer
      // bubble immediately (and supersede — a user cancel mid-cleanup is
      // honored). `halt` does NOT short-circuit finalizers (they all run).
      let finalizerError: Error | null = null;
      for (const fin of finalizerPhases) {
        try {
          yield* executeNode(fin, ctx, ctx.lastOutput);
        } catch (err) {
          if (err instanceof RunCancelled || err instanceof RunPauseRequested) throw err;
          if (err instanceof BudgetExceededError) throw err;
          yield {
            type: 'phase-error',
            phaseName: fin.name,
            error: (err as Error).message,
            ts: Date.now(),
          };
          // continueOnError finalizers don't even register an error to
          // propagate; otherwise remember the FIRST finalizer failure so it
          // can surface only if no original error preceded it.
          if (!fin.continueOnError && finalizerError === null) {
            finalizerError = err as Error;
          }
        }
      }

      // The original error always wins; a finalizer error only surfaces when
      // the regular sequence succeeded.
      if (unwindError) throw unwindError;
      if (finalizerError) throw finalizerError;
    } finally {
      yield { type: 'composite-end', phaseName: node.name, kind: 'phases', ts: Date.now() };
    }
    return;
  }

  // Composite: parallel / converge.
  const compKind = compositeKey(node);
  if (compKind === 'parallel' || compKind === 'converge') {
    yield { type: 'composite-start', phaseName: node.name, kind: compKind, ts: Date.now() };
    const branchFailures: Error[] = [];
    try {
      // Literal `node.parallel` / `node.converge` reads (not `node[compKind]`)
      // so the dispatch branch stays self-evident — and greppable by the
      // preview ↔ executor structural-parity guard (preview.structure.test.ts),
      // which asserts every body kind has a visible dispatch site here.
      const branches = (
        compKind === 'parallel' ? node.parallel : node.converge
      ) as Node[];
      // Single-writer isolation. Each branch runs against its OWN copy
      // of `state` / `scope` / `subflowStack`, so concurrent `as:`
      // writes (and subflow cycle-detection) cannot race or bleed
      // across branches. `usage` + `budgets` deliberately stay shared
      // by reference — they are monotonic counters, and budget
      // enforcement must see the cross-branch total. Each branch's
      // state writes are folded back into the parent deterministically
      // after the join (see the single-writer merge below).
      const stateBefore: State = { ...ctx.state };
      const branchContexts: ExecutorContext[] = branches.map(() => ({
        ...ctx,
        lastOutput: input,
        state: { ...ctx.state },
        scope: { ...ctx.scope },
        subflowStack: [...ctx.subflowStack],
      }));
      // Track which branches have FINISHED (success or caught failure), so a
      // deadline hit can finalize with the completed branches' outputs — and
      // WHICH branch failed with what (per-index), so a failure-partial can
      // tell the succeeded branches apart and attribute each failure to its
      // branch by name (the flat failures list only carried messages). Each
      // branch's iterator records its own error + sets its done flag.
      const branchDone: boolean[] = branches.map(() => false);
      const branchErrors: (Error | undefined)[] = branches.map(() => undefined);
      const trackDone = (i: number, iter: AsyncIterable<ProtectedEvent<RunEvent>>) =>
        (async function* () {
          for await (const wrapped of iter) {
            if ('err' in wrapped) branchErrors[i] = wrapped.err;
            yield wrapped;
          }
          branchDone[i] = true;
        })();
      const branchIters = branches.map((branch, i) =>
        trackDone(i, protect(executeNode(branch, branchContexts[i], input))),
      );
      let partialTimedOut = false;
      for await (const wrapped of drainWithDeadline(
        mergeIterators(branchIters),
        ctx.compositeDeadlineMs,
        () => {
          partialTimedOut = true;
        },
      )) {
        if ('err' in wrapped) {
          if (wrapped.err instanceof RunCancelled || wrapped.err instanceof RunPauseRequested) throw wrapped.err;
          if (wrapped.err instanceof BudgetExceededError) throw wrapped.err;
          branchFailures.push(wrapped.err);
          continue;
        }
        yield wrapped.ok;
      }

      // Finalize-with-partials. The fan-out hit its hard deadline with some
      // branches still in flight: instead of discarding everything, emit a
      // `composite-partial` and hand downstream the COMPLETED branches' outputs
      // (joined, branch-index order). We fold the completed branches' state
      // writes back FIRST (so a defect-collector branch that finished still
      // contributes its `as:` reducer delta), then return cleanly — a partial
      // result flows on rather than the run aborting with nothing. In-flight
      // branches contributed nothing (their isolated context never merged), so
      // the partial is internally consistent.
      if (partialTimedOut) {
        // In-flight branches contribute nothing (their isolated context never
        // merged); conflicts are deliberately not emitted on a partial.
        foldIsolatedStates(ctx, stateBefore, branchContexts, i => branchDone[i]);
        const completedOutputs = branchContexts
          .filter((_, i) => branchDone[i])
          .map(bc => bc.lastOutput);
        yield {
          type: 'composite-partial',
          phaseName: node.name,
          kind: compKind,
          completed: completedOutputs.length,
          total: branches.length,
          ts: Date.now(),
        };
        ctx.lastOutput = completedOutputs.join('\n\n---\n\n');
        return;
      }

      // FAILURE-PARTIALS. The drain finished (no deadline) but some branches
      // failed without `continueOnError`. Treating partial failure as total
      // would let ONE failed branch throw away every sibling success AND
      // their state merges — a sweep that found real issues on nine branches
      // reports none because the tenth died. The contract instead, mirroring the deadline partial above:
      //   - every branch failure gets its OWN `phase-error`, attributed to the
      //     failing branch by name (otherwise it is legible only inside the
      //     aggregate message);
      //   - at least one success → fold the SUCCEEDED branches' state, emit
      //     `composite-partial` (with `failed`), hand downstream the succeeded
      //     branches' outputs (joined pipe + structured array for `as`), and
      //     CONTINUE — no throw. A converge `merger` is skipped on a partial,
      //     same as the deadline path (it would summarize an incomplete set as
      //     if it were whole).
      //   - ALL branches failed → aggregate `phase-error` + throw (there is
      //     nothing to salvage; retry / onError apply).
      if (branchFailures.length > 0) {
        const succeeded = branches.map(
          (_, i) => branchDone[i] && branchErrors[i] === undefined,
        );
        const completedCount = succeeded.filter(Boolean).length;
        if (completedCount === 0) {
          const summary = branchFailures.map(e => e.message).join('; ');
          yield {
            type: 'phase-error',
            phaseName: node.name,
            error: `${branchFailures.length} branch(es) failed: ${summary}`,
            ts: Date.now(),
          };
          throw new Error(
            `composite "${node.name}" had ${branchFailures.length} failed branch(es)`,
          );
        }
        for (let i = 0; i < branches.length; i++) {
          const err = branchErrors[i];
          if (!err) continue;
          yield {
            type: 'phase-error',
            phaseName: branches[i].name,
            error: err.message,
            ts: Date.now(),
          };
        }
        foldIsolatedStates(ctx, stateBefore, branchContexts, i => succeeded[i]);
        const completedOutputs = branchContexts
          .filter((_, i) => succeeded[i])
          .map(bc => bc.lastOutput);
        yield {
          type: 'composite-partial',
          phaseName: node.name,
          kind: compKind,
          completed: completedCount,
          total: branches.length,
          failed: branchFailures.length,
          ts: Date.now(),
        };
        ctx.lastOutput = completedOutputs.join('\n\n---\n\n');
        ctx.lastOutputValue = completedOutputs.map(tryParseJson);
        return;
      }

      // Single-writer merge (foldIsolatedStates): each branch's `state` writes
      // fold back into the parent in branch-INDEX order — not completion order
      // — so the merged state is identical regardless of which branch happened
      // to finish first. This is what makes a converge deterministic: a resume
      // / replay reproduces the same state.
      //
      // For undeclared keys: a key written by more than one branch keeps the
      // highest-index branch's value and emits a state-conflict diagnostic so
      // the ambiguity is visible.
      //
      // For declared reducer keys: each branch's DELTA against the pre-fork
      // snapshot is folded into the parent in branch order via the reducer.
      // Multiple branches writing to the same declared key is the WHOLE POINT
      // (e.g. a parallel persona × component QA pass all appending to
      // `defectList`) — so no conflict is emitted; the reducer handles it.
      for (const key of foldIsolatedStates(
        ctx,
        stateBefore,
        branchContexts,
        () => true,
      )) {
        yield {
          type: 'state-conflict',
          phaseName: node.name,
          key,
          ts: Date.now(),
        };
      }

      const branchOutputs = branchContexts.map((bc, i) => ({
        name: branches[i].name,
        output: bc.lastOutput,
      }));
      if (compKind === 'converge' && node.merger) {
        const mergerInput = branchOutputs
          .map(b => `## Branch: ${b.name}\n\n${b.output}`)
          .join('\n\n---\n\n');
        const mergerNode: Node = {
          name: `${node.name}/merger`,
          agent: node.merger,
        };
        yield* runAgentPhase(mergerNode, node.merger, ctx, mergerInput);
      } else {
        ctx.lastOutput = branchOutputs.map(b => b.output).join('\n\n---\n\n');
      }
    } finally {
      yield { type: 'composite-end', phaseName: node.name, kind: compKind, ts: Date.now() };
    }
    return;
  }

  // Loop: refinement.
  if (node.loop) {
    yield { type: 'composite-start', phaseName: node.name, kind: 'loop', ts: Date.now() };
    try {
      const cfg = node.loop;
      const max = Math.max(1, cfg.maxIterations ?? 3);
      const body = cfg.body;
      // Efficient handoff (stateless — preserves checkpoint/skip-replay
      // durability): by default, frame re-iterations as a refinement of work
      // that already exists so the worker builds on it instead of
      // cold-starting and re-deriving context every round. `carryContext:
      // false` restores the legacy raw passthrough; `warmSession: true`
      // carries the full iteration history forward (stronger, but the
      // context grows each round, so it's opt-in).
      const carryContext = cfg.carryContext !== false; // default on
      const warmSession = cfg.warmSession === true; // opt-in
      // Per-item failure CAP (anti-retry-storm bound). Under `retryOnFailure`,
      // `maxFailures` stops the loop after that many CONSECUTIVE failing
      // iterations instead of grinding the full `maxIterations` re-doing work
      // that keeps failing (the validate-fails-every-time storm). A successful
      // iteration resets the streak. Unset / <1 ⇒ unbounded (only
      // `maxIterations` bounds the loop, exactly as before). Ignored without
      // `retryOnFailure` (a non-retrying loop has no failure streak to cap).
      const maxFailures =
        cfg.retryOnFailure && cfg.maxFailures && cfg.maxFailures > 0
          ? Math.floor(cfg.maxFailures)
          : 0;
      let consecutiveFailures = 0;
      const history: string[] = [];
      let cursorInput = input;
      for (let i = 0; i < max; i++) {
        yield {
          type: 'loop-iteration',
          phaseName: node.name,
          iteration: i + 1,
          ts: Date.now(),
        };

        // Frame the body input for re-iterations (i > 0). The first pass
        // runs on the raw input unchanged so loop semantics are unchanged
        // for the initial attempt.
        let bodyInput = cursorInput;
        if (i > 0 && warmSession && history.length > 0) {
          const trail = history
            .map((h, n) => `--- iteration ${n + 1} result ---\n${h}`)
            .join('\n\n');
          bodyInput =
            `[Warm refinement loop — iteration ${i + 1} of ${max}. The full ` +
            `history of prior iterations is below. You are continuing the SAME ` +
            `task; your earlier work persists (in the working tree / prior ` +
            `outputs). Do NOT restart or re-derive context — make only the ` +
            `incremental changes the latest feedback calls for.]\n\n` +
            `${trail}\n\n--- latest feedback (address this) ---\n${cursorInput}`;
        } else if (i > 0 && carryContext) {
          bodyInput =
            `[Refinement iteration ${i + 1} of ${max}. You are continuing prior ` +
            `work that already exists (in the working tree / from the previous ` +
            `iteration) — do not start over. Apply only the changes needed to ` +
            `address the feedback below.]\n\n${cursorInput}`;
        }

        let iterationFailed = false;
        let loopExhausted = false;
        // Iteration-scoped replay keys: the body's leaves keep their display
        // names but checkpoint under `<loop>@<iteration>/<name>`, so a resume
        // replays each iteration's OWN output instead of collapsing every
        // pass onto the first one. Shares state/scope with the parent (same
        // contract as serial map); only lastOutput is copied back by value.
        const iterCtx: ExecutorContext = {
          ...ctx,
          replayScope: `${replayKeyFor(ctx, node.name)}@${i + 1}`,
        };
        try {
          yield* executeNode(body, iterCtx, bodyInput);
          // A clean iteration breaks the failure streak (so an intermittent
          // blip never trips the consecutive-failure cap).
          consecutiveFailures = 0;
        } catch (err) {
          if (err instanceof RunCancelled || err instanceof RunPauseRequested) throw err;
          if (err instanceof BudgetExceededError) throw err;
          // TERMINAL failure inside the loop body (anti-retry-storm): the body
          // declared its failure do-not-retry, so re-iterating would re-do work
          // that is known-pointless to retry. Stop the loop now — even under
          // `retryOnFailure`. The terminal `phase-terminal` event was already
          // emitted by the inner executeNode; we just don't loop back.
          if (isTerminalFailure(err)) {
            iterCtx.lastOutput = `[iteration ${i + 1} failed terminally: ${(err as TerminalPhaseError).reason ?? (err as Error).message}]\n${iterCtx.lastOutput}`;
            ctx.lastOutput = iterCtx.lastOutput;
            yield {
              type: 'loop-exhausted',
              phaseName: node.name,
              iteration: i + 1,
              failures: consecutiveFailures + 1,
              maxFailures,
              ts: Date.now(),
            };
            break;
          }
          if (cfg.retryOnFailure) {
            iterationFailed = true;
            consecutiveFailures += 1;
            iterCtx.lastOutput = `[previous iteration failed: ${(err as Error).message}]\n${iterCtx.lastOutput}`;
            // Per-item failure cap: this many CONSECUTIVE failures means the
            // loop is grinding (the validator/infra is likely the problem, not
            // the fix). Give up — stop re-doing the work — instead of burning
            // every remaining iteration.
            if (maxFailures > 0 && consecutiveFailures >= maxFailures) {
              loopExhausted = true;
            }
          } else {
            throw err;
          }
        }
        ctx.lastOutput = iterCtx.lastOutput;

        if (loopExhausted) {
          yield {
            type: 'loop-exhausted',
            phaseName: node.name,
            iteration: i + 1,
            failures: consecutiveFailures,
            maxFailures,
            ts: Date.now(),
          };
          break;
        }

        // The body (or something deeper) halted — stop iterating.
        if (ctx.halted.v) break;

        cursorInput = ctx.lastOutput;
        const output = ctx.lastOutput;
        if (warmSession) history.push(output);
        const lower = output.toLowerCase();

        if (cfg.until && lower.includes(cfg.until.toLowerCase())) {
          yield {
            type: 'loop-stopped',
            phaseName: node.name,
            iteration: i + 1,
            reason: `output contains "${cfg.until}"`,
            ts: Date.now(),
          };
          break;
        }
        if (cfg.whileOutput && !lower.includes(cfg.whileOutput.toLowerCase())) {
          yield {
            type: 'loop-stopped',
            phaseName: node.name,
            iteration: i + 1,
            reason: `output no longer contains "${cfg.whileOutput}"`,
            ts: Date.now(),
          };
          break;
        }
        if (cfg.judge && !iterationFailed) {
          const judgeNode: Node = {
            name: `${node.name}/judge-${i + 1}`,
            agent: cfg.judge,
          };
          // Two prompts: STOP/CONTINUE (the default) or a numeric
          // quality score (when `stopAtScore` is set). Both ask for a small
          // JSON verdict; the literal STOP escape hatch still works in either
          // mode. The decision is parsed structured-first with a substring
          // fallback (see control-flow.ts) so old judge agents that reply with
          // a bare "STOP" / "0.95" keep working.
          const judgePrompt =
            cfg.stopAtScore != null
              ? `Last iteration output:\n\n${output}\n\n---\nScore the output's quality (higher is better). Reply with ONLY a JSON object {"score": <number on a 0–1 scale>, "stop": <true if the output is already final regardless of score, else false>}.`
              : `Last iteration output:\n\n${output}\n\n---\nDecide: should the loop CONTINUE for another iteration or STOP? Reply with ONLY a JSON object {"decision": "STOP"} or {"decision": "CONTINUE"}.`;
          yield* runAgentPhase(judgeNode, cfg.judge, ctx, judgePrompt);
          const verdict = ctx.lastOutput.trim();
          const judged = decideLoopJudge(verdict, {
            stopAtScore: cfg.stopAtScore,
          });
          if (judged.stop) {
            yield {
              type: 'loop-stopped',
              phaseName: node.name,
              iteration: i + 1,
              reason: judged.reason,
              ts: Date.now(),
            };
            ctx.lastOutput = output;
            break;
          }
          ctx.lastOutput = output;
          cursorInput = output;
        }
      }
    } finally {
      yield { type: 'composite-end', phaseName: node.name, kind: 'loop', ts: Date.now() };
    }
    return;
  }

  // Conversation.
  if (node.conversation) {
    yield {
      type: 'composite-start', phaseName: node.name, kind: 'conversation', ts: Date.now(),
    };
    try {
      const participants = node.conversation.participants;
      const rounds = Math.max(1, node.conversation.rounds ?? 4);
      if (participants.length === 0) {
        yield {
          type: 'phase-error',
          phaseName: node.name,
          error: 'conversation has no participants',
          ts: Date.now(),
        };
        throw new Error(`conversation "${node.name}" has no participants`);
      }
      let transcript = input ? `[input]\n${input}` : '[start]';
      for (let turn = 0; turn < rounds; turn++) {
        const speakerIdx = turn % participants.length;
        const agentPath = participants[speakerIdx];
        const speakerName =
          agentPath.split('/').pop()?.replace(/\.md$/, '') ?? agentPath;
        const turnNode: Node = {
          name: `${node.name}/turn-${turn + 1}-${speakerName}`,
          agent: agentPath,
        };
        yield* runAgentPhase(turnNode, agentPath, ctx, transcript);
        transcript += `\n\n[${speakerName}]\n${ctx.lastOutput}`;
      }
      ctx.lastOutput = transcript;
    } finally {
      yield {
        type: 'composite-end', phaseName: node.name, kind: 'conversation', ts: Date.now(),
      };
    }
    return;
  }

  // Route.
  if (node.route) {
    yield { type: 'composite-start', phaseName: node.name, kind: 'route', ts: Date.now() };
    try {
      const branches = node.route.branches;
      const branchKeys = Object.keys(branches);
      let chosenKey: string | null = null;
      let decisionText = input;

      if (node.route.router) {
        // Ask for a structured verdict; parsed structured-first with a
        // substring fallback (control-flow.ts), so a router that replies with
        // a bare branch name still routes correctly. "Classify" is retained so
        // existing router agents keyed on it behave the same.
        const routerPrompt = `Classify the input. Reply with ONLY a JSON object {"branch": "<one of: ${branchKeys.join(', ')}${node.route.default ? ', default' : ''}>"}.\n\nInput:\n${input}`;
        const routerNode: Node = {
          name: `${node.name}/router`,
          agent: node.route.router,
        };
        yield* runAgentPhase(routerNode, node.route.router, ctx, routerPrompt);
        decisionText = ctx.lastOutput;
      }

      const routed = decideRoute(decisionText, branchKeys, !!node.route.default);
      chosenKey = routed?.branch ?? null;

      if (chosenKey) {
        yield {
          type: 'route-decision',
          phaseName: node.name,
          branch: chosenKey,
          ts: Date.now(),
        };
        yield* executeNode(branches[chosenKey], ctx, input);
      } else if (node.route.default) {
        yield {
          type: 'route-decision',
          phaseName: node.name,
          branch: 'default',
          ts: Date.now(),
        };
        yield* executeNode(node.route.default, ctx, input);
      } else {
        yield {
          type: 'phase-error',
          phaseName: node.name,
          error: `route: no matching branch and no default. Decision was: ${decisionText.slice(0, 100)}`,
          ts: Date.now(),
        };
        throw new Error(`route "${node.name}" had no matching branch`);
      }
    } finally {
      yield { type: 'composite-end', phaseName: node.name, kind: 'route', ts: Date.now() };
    }
    return;
  }

  // Switch: deterministic value-based case selection (and if/else, via
  // true/false cases). The value is matched EXACTLY against case keys —
  // unlike `route`, which can use an LLM router or loose substring match.
  if (node.switch) {
    yield { type: 'composite-start', phaseName: node.name, kind: 'switch', ts: Date.now() };
    try {
      const cases = node.switch.cases;
      // What to switch on + which case it selects — resolved by the shared
      // `selectSwitchCase` (the `on` expression interpolated over state+scope,
      // or the upstream phase output when `on` is unset, then `decideSwitch`).
      // Preview calls the same helper so a static switch resolves identically.
      const unresolvedOn: string[] = [];
      const switchLookup = lookupState(ctx, input);
      const { value, matched } = selectSwitchCase(
        node.switch,
        input,
        switchLookup,
        ref => unresolvedOn.push(ref),
      );
      // An unresolved `on` reference leaves the literal `${…}`, which matches
      // no case. When its BASE names nothing (a typo, a step that never ran)
      // that is a bug, and falling to `default` would hide it — a default
      // that files a ticket filed a duplicate on every event. Fail. When the
      // base exists but the FIELD is missing (an empty search result, a map
      // item without an optional field), `default` is the long-standing and
      // intended behavior — keep it, but say so.
      const { missingBase, missingField } = classifyUnresolved(unresolvedOn, switchLookup);
      if (missingBase.length > 0) {
        const msg =
          `switch: \`on\` reference(s) ${missingBase.map(r => '${' + r + '}').join(', ')} ` +
          'name nothing in this run (a typo, or a step that never ran) — refusing to pick a case';
        yield { type: 'phase-error', phaseName: node.name, error: msg, ts: Date.now() };
        throw new Error(msg);
      }
      // (A missing field is reported on the route-decision below — NOT as
      // `interpolation-unresolved`, which marks a done run degraded: taking
      // default here is the intended path, and existing runs must not start
      // reporting as degraded for it.)
      if (matched != null) {
        // Reuse route-decision so the existing trace UI surfaces the chosen
        // case with no extra event plumbing. The branch runs on the original
        // input (same as route), so a case can still see upstream context.
        yield {
          type: 'route-decision',
          phaseName: node.name,
          branch: matched,
          ts: Date.now(),
        };
        yield* executeNode(cases[matched], ctx, input);
      } else if (node.switch.default) {
        yield {
          type: 'route-decision',
          phaseName: node.name,
          branch: 'default',
          ...(missingField.length > 0 ? { unresolved: missingField } : {}),
          ts: Date.now(),
        };
        yield* executeNode(node.switch.default, ctx, input);
      } else {
        yield {
          type: 'phase-error',
          phaseName: node.name,
          error: `switch: value "${String(value).slice(0, 80)}" matched no case and no default`,
          ts: Date.now(),
        };
        throw new Error(`switch "${node.name}" had no matching case`);
      }
    } finally {
      yield { type: 'composite-end', phaseName: node.name, kind: 'switch', ts: Date.now() };
    }
    return;
  }

  // Map: fan-out over array.
  if (node.map) {
    yield { type: 'composite-start', phaseName: node.name, kind: 'map', ts: Date.now() };
    try {
      const cfg = node.map;
      let items: unknown[];
      try {
        items = resolveOver(cfg.over, lookupState(ctx, input));
      } catch (err) {
        yield {
          type: 'phase-error',
          phaseName: node.name,
          error: (err as Error).message,
          ts: Date.now(),
        };
        throw err;
      }
      const total = items.length;
      // Engine-enforced fan-out bound: the array can be LLM-determined, so an
      // unbounded map is an unbounded blast radius. Over the cap fails the
      // phase (raise sandbox.maxFanout to opt into a larger fan-out).
      const mapSandbox = ctx.sandboxByPhase.get(node.name);
      const maxFanout = mapSandbox?.maxFanout ?? DEFAULT_MAX_FANOUT;
      if (total > maxFanout) {
        const msg = `map fan-out ${total} exceeds cap ${maxFanout} (raise sandbox.maxFanout)`;
        yield {
          type: 'phase-error',
          phaseName: node.name,
          error: msg,
          ts: Date.now(),
        };
        throw new Error(msg);
      }
      const perItemOutputs: string[] = new Array(total);
      // Per-item failure slot (parallel path). `runItem` records the error
      // for a NON-continueOnError item failure before rethrowing, so the
      // failure-partial finalize below can tell succeeded items apart and
      // attribute each failure to its index.
      const itemErrors: (Error | undefined)[] = new Array(total);

      // Serial map: iterations share state by design — each iteration
      // sees the previous one's `as:` writes (that's why you'd opt in
      // to serial). Parallel map: each iteration gets ISOLATED state /
      // scope / subflowStack, and writes are folded back into the
      // parent in INDEX order after the join — same single-writer
      // semantics as converge. The serial path keeps current behavior
      // unchanged; only parallel gets the isolation treatment.
      const buildItemCtx = (
        idx: number,
        sharedState: boolean,
      ): ExecutorContext => {
        const item = items[idx];
        const itemScope: State = {
          ...ctx.scope,
          item: item as unknown,
          index: idx,
        };
        // Item-scoped replay keys: every item's leaves checkpoint under
        // `<map>[<idx>]/<name>` so a resume replays each item's OWN output
        // (the bare body name would collapse all items onto one key).
        const itemReplayScope = `${replayKeyFor(ctx, node.name)}[${idx}]`;
        return sharedState
          ? {
              ...ctx,
              scope: itemScope,
              replayScope: itemReplayScope,
              lastOutput:
                typeof item === 'string' ? item : JSON.stringify(item),
            }
          : {
              ...ctx,
              scope: itemScope,
              replayScope: itemReplayScope,
              state: { ...ctx.state },
              subflowStack: [...ctx.subflowStack],
              lastOutput:
                typeof item === 'string' ? item : JSON.stringify(item),
            };
      };

      const runItem = async function* (
        idx: number,
        itemCtx: ExecutorContext,
      ): AsyncIterable<RunEvent> {
        yield {
          type: 'map-iteration',
          phaseName: node.name,
          iteration: idx + 1,
          total,
          ts: Date.now(),
        };
        try {
          yield* executeNode(cfg.body, itemCtx, itemCtx.lastOutput);
        } catch (err) {
          // continueOnError: surface the error + move on; otherwise
          // bubble. RunCancelled / pause / budget always bubble.
          if (err instanceof RunCancelled || err instanceof RunPauseRequested)
            throw err;
          if (err instanceof BudgetExceededError) throw err;
          if (!cfg.body.continueOnError) {
            itemErrors[idx] = err as Error;
            throw err;
          }
          yield {
            type: 'phase-error',
            phaseName: cfg.body.name,
            error: (err as Error).message,
            ts: Date.now(),
          };
          // MARK the failed item's output slot. It used to silently keep
          // `itemCtx.lastOutput` — usually the item INPUT echoed back (the
          // body failed before producing anything) — so downstream consumers
          // of the joined pipe / structured array could not tell a swallowed
          // failure from a body that legitimately returned its input. The
          // marker string replaces both surfaces (the pipe join and the `as`
          // array element — tryParseJson leaves a non-JSON string as-is), so
          // a failure is legible exactly where the echo used to hide.
          perItemOutputs[idx] = `[FAILED item ${idx}] ${(err as Error).message}`;
          return;
        }
        perItemOutputs[idx] = itemCtx.lastOutput;
      };

      if (cfg.serial) {
        for (let i = 0; i < total; i++) {
          yield* runItem(i, buildItemCtx(i, true));
          // An item carrying `halt` stops the remaining items.
          if (ctx.halted.v) break;
        }
      } else {
        const stateBefore: State = { ...ctx.state };
        const itemContexts: ExecutorContext[] = items.map((_, i) =>
          buildItemCtx(i, false),
        );
        // Concurrency cap: run in batches of `limit` (default: all at once).
        // Bounds parallel fan-out to a pool of N (e.g. 3 simulators) WITHOUT
        // changing the isolated-state / index-ordered-merge semantics — items in
        // a later batch leave their context untouched until they run, so they
        // contribute nothing to the merge before then. A batch waits for its
        // slowest item before the next starts; that's the cost of the bound.
        const limit =
          cfg.concurrency && cfg.concurrency > 0
            ? Math.min(cfg.concurrency, total)
            : total;
        const failures: Error[] = [];
        let partialTimedOut = false;
        for (let start = 0; start < total && !partialTimedOut; start += limit) {
          const end = Math.min(start + limit, total);
          const batch = itemContexts
            .slice(start, end)
            .map((itemCtx, j) => protect(runItem(start + j, itemCtx)));
          // Race this batch's drain against the map's hard deadline. A timeout
          // stops draining (and breaks the outer batch loop) so the map can
          // finalize with the items completed so far instead of losing the lot.
          for await (const wrapped of drainWithDeadline(
            mergeIterators(batch),
            ctx.compositeDeadlineMs,
            () => {
              partialTimedOut = true;
            },
          )) {
            if ('err' in wrapped) {
              if (
                wrapped.err instanceof RunCancelled ||
                wrapped.err instanceof RunPauseRequested
              )
                throw wrapped.err;
              if (wrapped.err instanceof BudgetExceededError) throw wrapped.err;
              failures.push(wrapped.err);
              continue;
            }
            yield wrapped.ok;
          }
        }
        // Finalize-with-partials. The fan-out hit its hard deadline: emit a
        // `composite-partial` and hand downstream the COMPLETED items' outputs.
        // `runItem` fills `perItemOutputs[idx]` only when an item finishes, so
        // the filled slots ARE exactly the completed items; in-flight items left
        // their slot undefined and their isolated state unmerged. Fold the
        // completed items' state writes first (a reducer-collector item that
        // finished still counts), then return the partial as this map's output.
        if (partialTimedOut) {
          // In-flight items left their slot undefined and their isolated
          // state unmerged; conflicts are deliberately not emitted on a
          // partial.
          foldIsolatedStates(
            ctx,
            stateBefore,
            itemContexts,
            i => perItemOutputs[i] !== undefined,
          );
          const completed = perItemOutputs.filter(o => o !== undefined);
          yield {
            type: 'composite-partial',
            phaseName: node.name,
            kind: 'map',
            completed: completed.length,
            total,
            ts: Date.now(),
          };
          // Join only the completed items for the pipe; expose the completed
          // items (in index order) as the structured `as` value.
          ctx.lastOutput = completed.join('\n\n---\n\n');
          ctx.lastOutputValue = completed.map(tryParseJson);
          return;
        }
        // FAILURE-PARTIALS — the map twin of the parallel/converge path above.
        // The drain finished but some items failed without `continueOnError`
        // (a swallowed continueOnError failure never lands in `failures`; it
        // completed with a `[FAILED item N]` marker slot instead). Old
        // behavior: one failed item threw away every completed sibling's
        // output AND state merge. New contract:
        //   - every failed item gets its OWN `phase-error` naming the item
        //     index (runItem only emits one for continueOnError items);
        //   - at least one item completed → fold the COMPLETED items' state
        //     (their slot is filled; a failed item's isolated context never
        //     merges), emit `composite-partial` (with `failed`), hand
        //     downstream the completed items' outputs, and CONTINUE;
        //   - ALL items failed → aggregate `phase-error` + throw, exactly as
        //     before.
        if (failures.length > 0) {
          const completedIdx = itemContexts.map(
            (_, i) => perItemOutputs[i] !== undefined,
          );
          const completedCount = completedIdx.filter(Boolean).length;
          if (completedCount === 0) {
            const summary = failures.map(e => e.message).join('; ');
            yield {
              type: 'phase-error',
              phaseName: node.name,
              error: `${failures.length} map iteration(s) failed: ${summary}`,
              ts: Date.now(),
            };
            throw new Error(
              `map "${node.name}" had ${failures.length} failed iteration(s)`,
            );
          }
          for (let i = 0; i < total; i++) {
            const err = itemErrors[i];
            if (!err) continue;
            yield {
              type: 'phase-error',
              phaseName: cfg.body.name,
              error: `map item ${i} failed: ${err.message}`,
              ts: Date.now(),
            };
          }
          foldIsolatedStates(ctx, stateBefore, itemContexts, i => completedIdx[i]);
          const completed = perItemOutputs.filter(o => o !== undefined);
          yield {
            type: 'composite-partial',
            phaseName: node.name,
            kind: 'map',
            completed: completedCount,
            total,
            failed: failures.length,
            ts: Date.now(),
          };
          ctx.lastOutput = completed.join('\n\n---\n\n');
          ctx.lastOutputValue = completed.map(tryParseJson);
          return;
        }
        // Single-writer merge (foldIsolatedStates) — fold each iteration's
        // `state` writes back into the parent in INDEX order. Undeclared
        // keys: a key written by more than one iteration keeps the
        // highest-index value and emits a state-conflict diagnostic.
        // Declared reducer keys: each iteration's delta is folded into the
        // parent via the reducer — multiple iterations writing to the
        // same slot is the WHOLE POINT (a parallel map with each item
        // appending to a shared list), so no conflict is emitted.
        for (const key of foldIsolatedStates(
          ctx,
          stateBefore,
          itemContexts,
          () => true,
        )) {
          yield {
            type: 'state-conflict',
            phaseName: node.name,
            key,
            ts: Date.now(),
          };
        }
      }

      // Pipe output: join with delimiters (matches parallel/converge semantics).
      ctx.lastOutput = perItemOutputs.join('\n\n---\n\n');
      // `as` output: expose the per-item outputs as a TRUE array (each element
      // JSON-parsed when it looks like JSON, raw string otherwise) so a
      // downstream `${results.2.field}` resolves into the item — the joined
      // string still pipes to the next phase via lastOutput above.
      ctx.lastOutputValue = perItemOutputs.map(tryParseJson);
    } finally {
      yield { type: 'composite-end', phaseName: node.name, kind: 'map', ts: Date.now() };
    }
    return;
  }

  yield {
    type: 'phase-skipped',
    phaseName: node.name,
    reason: 'phase has no executable body',
    ts: Date.now(),
  };
}

/** Walk the orchestration tree and collect every (nodeName, tools) pair from
 *  leaf agent nodes that declare them. Recurses via the shared `childNodesOf`
 *  walker — the hand-rolled walk this replaced missed `switch` cases and
 *  `onStall.recover`, so tool declarations inside them dodged the run-start
 *  connector validation. */
function collectTools(node: Node, out: { nodeName: string; tools: string[] }[]) {
  if (node.agent && Array.isArray(node.tools) && node.tools.length > 0) {
    out.push({ nodeName: node.name, tools: node.tools });
  }
  for (const child of childNodesOf(node)) collectTools(child, out);
}

/** True if ANY node in the tree sets `code.run` (the arbitrary-shell escape
 *  hatch). Recurses every static composite via the shared `childNodesOf`
 *  walker — the hand-rolled walk this replaced knew about `switch` but not
 *  `onStall.recover`, so a `code.run` buried in a stall-recovery phase dodged
 *  the preflight and errored only when a stall actually fired it, mid-run.
 *  `conversation.participants` and `subflow` are string refs (agent paths /
 *  orchestration names), not inline node bodies, so they can't themselves
 *  carry `code.run` and are not descended; a subflow's own code.run is caught
 *  by the preflight of ITS run. Pure + side-effect-free. Used for the
 *  run-start preflight that fast-fails a code.run orchestration when
 *  SAMMY_ALLOW_CODE_RUN is unset, instead of erroring ~30s deep in a phase on
 *  every fire. Exported so the server's boot banner can warn — at startup,
 *  not at the first doomed fire — when a triggered orchestration uses code.run
 *  while the flag is off (one shared walker; the API must not duplicate it). */
export function orchestrationUsesCodeRun(root: Node): boolean {
  if (root.code?.run) return true;
  return childNodesOf(root).some(orchestrationUsesCodeRun);
}

/** Steps whose only body is a `skill` — doable by a harness, not a pipeline. */
export function skillOnlySteps(root: Node): string[] {
  const own = root.skill && compositeKey(root) == null && !root.agent && !root.code && !root.http && !root.wait && !root.a2a && !root.subflow
    ? [root.name]
    : [];
  return [...own, ...childNodesOf(root).flatMap(skillOnlySteps)];
}

/** Collect every `as:`-produced binding name in the tree — the run-wide set of
 *  values an upstream phase writes for a downstream `${name}` to read. Recurses
 *  every static composite via the shared `childNodesOf` walker (so an `as` in a
 *  switch case / onStall.recover is included). Pure. Used to seed
 *  `ctx.asProducers`, which tells an empty `as`-produced ref (a `binding-empty`)
 *  apart from an ordinary empty var. */
export function collectAsNames(root: Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: Node): void => {
    if (typeof n.as === 'string' && n.as) out.add(n.as);
    for (const child of childNodesOf(n)) visit(child);
  };
  visit(root);
  return out;
}

/** Collect every credential reference in the tree, each paired with the name
 *  of the owning node, so the run-start preflight can name BOTH the missing
 *  credential and the node that declares it. A node contributes one entry for
 *  `node.credential` and one for each `node.credentials[]` member. Recurses via
 *  the shared `childNodesOf` walker (every static composite — incl. `switch`
 *  cases and `onStall.recover` — so a credential buried inside either is still
 *  surfaced). (validate.ts has a sibling `collectCredentialRefs` that returns
 *  name-only `string[]` for the authoring UI; this one keeps the owning-node
 *  name the preflight message needs. Duplicates within a node — same name in
 *  both `credential` and `credentials` — are kept; the caller dedupes misses by
 *  message.) Pure + side-effect-free. */
function collectCredentialRefs(
  root: Node,
): { node: string; credential: string }[] {
  const out: { node: string; credential: string }[] = [];
  function visit(n: Node): void {
    if (typeof n.credential === 'string' && n.credential) {
      out.push({ node: n.name, credential: n.credential });
    }
    if (Array.isArray(n.credentials)) {
      for (const c of n.credentials) {
        if (typeof c === 'string' && c) out.push({ node: n.name, credential: c });
      }
    }
    for (const child of childNodesOf(n)) visit(child);
  }
  visit(root);
  return out;
}

/** Numeric precedence for `subflow` name resolution. Higher wins. An
 *  `imported` (domain / workspace-symlinked) orchestration outranks a
 *  `shipped` in-repo example; an unmarked node is treated as `shipped`. */
function orchestrationPrecedence(node: Node): number {
  return node.__origin === 'imported' ? 1 : 0;
}

/** Insert `node` into the by-name map honoring origin precedence: a higher-
 *  precedence entry (imported > shipped) replaces a lower one, a lower one
 *  never displaces a higher one, and a same-tier collision keeps last-write
 *  (back-compat with the prior readdir-order behavior). This is what makes a
 *  domain `ticket-to-pr` deterministically shadow the generic example rather
 *  than depending on which file the directory listing yielded last. */
function setOrchestrationWithPrecedence(
  map: Map<string, Node>,
  node: Node,
): void {
  const existing = map.get(node.name);
  if (
    existing &&
    orchestrationPrecedence(existing) > orchestrationPrecedence(node)
  ) {
    return; // keep the higher-precedence entry already present
  }
  map.set(node.name, node);
}

// ── Harness mode ────────────────────────────────────────────────────────────

/** Display phase for what the harness agent says and does between steps. */
const HARNESS_PHASE = 'harness';
/** How many times the engine tells an agent that stopped early to carry on
 *  before the run fails naming the unfinished steps. */
const HARNESS_MAX_NUDGES = 2;
/** Session legs in one executor call (gates, turn caps and nudges each start
 *  one) — a backstop against an agent that never finishes. */
const HARNESS_MAX_LEGS = 40;
/** A blocking step tool (run_step on a long engine step) must outlive the
 *  SDK's default MCP call timeouts; the run's own timeouts bound it. */
const HARNESS_TOOL_TIMEOUT_MS = String(24 * 60 * 60 * 1000);

type HarnessRunOptions = {
  /** The stream adapter can host a harness session (the server SDK path). */
  supported: boolean;
  /** Effective strictness, resolved by the server at run start. Absent: the
   *  orchestration's own `harness.follow` (a resumed leg, a test). */
  follow?: ResolvedFollow;
  /** Whether a skill a step names is installed where the agent runs. Absent:
   *  not checked. */
  skillExists?: (name: string) => boolean;
  /** Working directory for the agent when the run has no single worktree. */
  cwd?: string;
  /** The host's handle for driving the run from a terminal (see
   *  HarnessControl). Absent: the server's agent always drives. */
  control?: HarnessControl;
};

/** Ends a server-driven leg early so a terminal can take over. */
class HarnessLegInterrupted extends Error {}

/** A terminal-driven leg that calls no step tool for this long pauses the run
 *  (resumable) instead of holding it forever. SAMMY_HARNESS_TERMINAL_IDLE_SEC. */
const HARNESS_TERMINAL_IDLE_SEC = 30 * 60;

function newHarnessSessionId(): string {
  return globalThis.crypto.randomUUID();
}

/** Run an orchestration in harness mode: one agent follows the steps and does
 *  each itself; the engine checks the order, runs engine steps, holds gates
 *  and checkpoints every finished step (`harness/<key>`). A gate or a durable
 *  wait ends the session leg and pauses the run; the resumed leg continues
 *  the SAME session (`resume`), so the agent remembers the run. */
async function* runHarness(
  orchestration: Node,
  ctx: ExecutorContext,
  opts: HarnessRunOptions,
): AsyncIterable<RunEvent> {
  if (!opts.supported) {
    throw new Error(
      'Harness mode needs a server-owned run on the Claude Code (SDK) path — ' +
        'start it from the sammy-pack server, not from the browser or another runner.',
    );
  }
  const steps = compileRoadmap(orchestration);
  if (steps.length === 0) {
    throw new Error(`Harness mode: "${orchestration.name}" has no steps to follow.`);
  }

  // Preflight: a named skill that isn't installed, or a task step's agent file
  // that doesn't exist, would fail deep in the run — refuse now.
  const skills = [...new Set(steps.flatMap(s => (s.skill ? [s.skill] : [])))];
  if (opts.skillExists) {
    const missing = steps.filter(s => s.skill && !opts.skillExists!(s.skill));
    if (missing.length > 0) {
      throw new Error(
        'Run halted at preflight: ' +
          missing.map(s => `step "${s.name}" names the skill "${s.skill}", which isn't installed`).join('; ') +
          '. Install it (a SKILL.md under .claude/skills/<name>/ in the run\'s working directory or ~/.claude/skills/), or remove `skill` from the step.',
      );
    }
  }
  for (const s of steps) {
    if (s.kind === 'task' && s.agentPath && !s.agentPath.includes('${') && !ctx.agentByPath.has(s.agentPath)) {
      throw new Error(`Run halted at preflight: step "${s.name}" uses ${s.agentPath}, which doesn't exist.`);
    }
  }

  const resolved =
    opts.follow ??
    resolveFollow({ declared: orchestration.harness?.follow, locked: orchestration.harness?.lockFollow });

  // What earlier legs finished, from the checkpoints. A step a loop repeats
  // is checkpointed per pass (`harness/<loop>@<pass>/<key>`): restore the
  // latest pass, and the loop itself when its finish was recorded.
  const record = (key: string): StepRecord | null => {
    const raw = ctx.replayOutputs.get(HARNESS_CHECKPOINT_PREFIX + key);
    return raw !== undefined ? decodeStepRecord(raw) : null;
  };
  const restoredPasses = new Map<string, number>();
  for (const loopName of new Set(steps.flatMap(s => (s.loop ? [s.loop.name] : [])))) {
    let pass = 0;
    for (const key of ctx.replayOutputs.keys()) {
      const m = key.startsWith(`${HARNESS_CHECKPOINT_PREFIX}${loopName}@`)
        ? /@(\d+)\//.exec(key.slice(HARNESS_CHECKPOINT_PREFIX.length + loopName.length))
        : null;
      if (m) pass = Math.max(pass, Number(m[1]));
    }
    if (pass > 0) restoredPasses.set(loopName, pass);
  }
  const restored = new Map<string, StepRecord>();
  for (const s of steps) {
    const rec = record(s.loop ? `${s.loop.name}@${restoredPasses.get(s.loop.name) ?? 1}/${s.key}` : s.key);
    if (rec) restored.set(s.key, rec);
  }
  const progress = new HarnessProgress(steps, resolved.follow, restored, restoredPasses);
  // Rebuild what the finished steps left in run state, in order.
  const finishedLoops = new Set<string>();
  for (const s of steps) {
    const rec = restored.get(s.key);
    if (rec?.status === 'done') {
      ctx.lastOutput = rec.output ?? '';
      applyAs(s.node, ctx);
    }
    if (s.loop && !finishedLoops.has(s.loop.name)) {
      const loopRec = record(s.loop.name);
      if (loopRec?.status === 'done' && progress.passComplete(s.loop.name)) {
        finishedLoops.add(s.loop.name);
      }
    }
    // A loop's last step restored: the loop's own `as` follows its output.
    if (s.loop && finishedLoops.has(s.loop.name) && progress.loopSteps(s.loop.name).at(-1) === s) {
      ctx.lastOutput = record(s.loop.name)?.output ?? ctx.lastOutput;
      applyAs(s.loop.node, ctx);
    }
  }

  const model = orchestration.harness?.model ?? ctx.model;
  const cwd = ctx.defaultCwd ?? opts.cwd;

  // ── Tools ──
  const declaredClaudeTools = (s: HarnessStep): string[] =>
    (Array.isArray(s.node.tools) ? s.node.tools : []).filter(t => /^[A-Z]/.test(t));
  const ownTools = (s: HarnessStep): string[] => {
    if (!ctx.allowAgentTools) return [];
    return applyToolPolicy(declaredClaudeTools(s), effectiveSandboxFor(s.name, ctx.sandboxByPhase)).effectiveTools;
  };
  const sessionTools = new Set<string>([...HARNESS_ALWAYS_ALLOWED, ...HARNESS_TOOL_NAMES.map(harnessToolId)]);
  for (const s of steps) for (const t of ownTools(s)) sessionTools.add(t);
  if (skills.length > 0) sessionTools.add('Skill');
  /** What a step may use while it is active. A skill step that declares no
   *  tools of its own may use the session's (the skill brings its own steps). */
  const toolsFor = (s: HarnessStep): string[] => {
    if (s.kind === 'skill' && declaredClaudeTools(s).length === 0) {
      return ctx.allowAgentTools ? [...sessionTools] : [];
    }
    return ownTools(s);
  };
  const union = (pick: (n: Node) => unknown): string[] =>
    [...new Set(steps.flatMap(s => {
      const v = pick(s.node);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    }))];
  const mcpServers = union(n => n.mcp);
  const hookNames = union(n => n.hooks);
  const autoApprove = union(n => n.autoApproveTools);

  // Tools a step declares that this server won't hand out — said once, up front.
  if (!ctx.allowAgentTools) {
    for (const s of steps) {
      const declared = declaredClaudeTools(s);
      if (declared.length > 0) {
        yield { type: 'tools-warning', phaseName: s.name, missing: declared, ts: Date.now() };
      }
    }
  }

  // Credentials: one session means one process, so every credential a step
  // declares is in the session's environment for the whole run. Said plainly.
  const credNames = [...new Set(steps.flatMap(s => [
    ...(typeof s.node.credential === 'string' && s.node.credential ? [s.node.credential] : []),
    ...(Array.isArray(s.node.credentials) ? s.node.credentials.filter((n): n is string => typeof n === 'string' && !!n) : []),
  ]))];
  let credEnv: Record<string, string> = {};
  if (credNames.length > 0) {
    const entries = credNames.map(n => ctx.credentialsRaw[n]).filter((c): c is NonNullable<typeof c> => !!c);
    credEnv = credentialsToEnv(entries);
    for (const c of entries) if (typeof c.value === 'string' && c.value) ctx.injectedSecrets.add(c.value);
    if (Object.keys(credEnv).length > 0) {
      yield {
        type: 'harness-notice',
        message:
          `The harness works in one session, so these credentials are available to it for the whole run, ` +
          `not only in the steps that declare them: ${credNames.join(', ')}.`,
        ts: Date.now(),
      };
    }
  }

  // ── Session ──
  const priorSession = ctx.replayOutputs.get(HARNESS_SESSION_KEY);
  let sessionId = priorSession ?? newHarnessSessionId();
  let resumeSession = priorSession !== undefined;
  const recordSession = (): RunEvent => {
    ctx.replayOutputs.set(HARNESS_SESSION_KEY, sessionId);
    return {
      type: 'harness-step',
      key: '__session',
      phaseName: HARNESS_PHASE,
      status: 'done',
      by: 'engine',
      record: sessionId,
      replayKey: HARNESS_SESSION_KEY,
      ts: Date.now(),
    };
  };
  if (!priorSession) yield recordSession();

  // ── Step tools ──
  let queue = new HarnessEventQueue<RunEvent>();
  // Set by the step tools while the agent's stream runs; read after it ends.
  const halt: { gate: HarnessStep | null; gateName: string | null; stop: Error | null } = {
    gate: null,
    gateName: null,
    stop: null,
  };
  const approvedGates = new Set<string>();
  // A gate already crossed in an earlier leg (its step, or a later pass of
  // its loop, has a record) doesn't stop the run again.
  for (const s of steps) {
    if (restored.has(s.key) || (s.loop && progress.passOf(s.loop.name) > 1)) for (const g of s.gates) approvedGates.add(g);
  }
  const startedAt = new Map<string, number>();
  const slot: { release: (() => void) | null } = { release: null };
  /** Let go of the active step without finishing it (its leg ended). */
  const releaseActive = (): void => {
    if (progress.active) stepBudget.leave(progress.active);
    progress.release();
  };
  /** Steps re-opened after they finished (loose / advisory order). */
  const reopened = new Set<string>();
  /** The active step's own `budget`, in force while it is active — as a
   *  pipeline holds a node's budget while the node runs. */
  const stepBudget = {
    enter(s: HarnessStep): void {
      if (!s.node.budget) return;
      ctx.budgets.push({
        budget: s.node.budget,
        nodeName: s.name,
        tokensAtEntry: ctx.usage.totalInputTokens + ctx.usage.totalOutputTokens,
        costAtEntry: ctx.usage.totalCostUsd,
      });
    },
    leave(s: HarnessStep): void {
      const i = ctx.budgets.findIndex(b => b.nodeName === s.name && b.budget === s.node.budget);
      if (i >= 0) ctx.budgets.splice(i, 1);
    },
  };
  const control = opts.control;
  // A terminal taking over ends the server agent's leg — but not in the
  // middle of an engine step, whose run_step is still waiting on it.
  const engine = { running: false, interruptPending: false, interrupted: false };
  const requestInterrupt = (): void => {
    if (engine.running) {
      engine.interruptPending = true;
      return;
    }
    engine.interrupted = true;
    queue.push({
      type: 'harness-notice',
      message: 'A terminal is taking over the run; ending the server agent\'s session leg.',
      ts: Date.now(),
    });
  };
  const acquireSlot = async () => {
    slot.release?.();
    slot.release = await agentSlots.acquire({
      runId: ctx.runId,
      orchestrationName: ctx.orchestrationName,
      phaseName: HARNESS_PHASE,
    });
  };
  /** A server leg's agent holds a slot while its leg lives; run_step gives
   *  it back for the engine step and takes it again only if the leg still
   *  lives — else a cancel or a dead session would leak a slot for good. */
  const legLive = { v: false };

  // ── Spend: charged as the session reports it (budgets hold mid-leg), and
  //    attributed to the step it was spent on.
  const spend = {
    charged: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 },
    step: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
  /** Fold the session's cumulative usage into the run totals; a breach is
   *  returned for the caller to stop on. */
  const chargeUsage = (u: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): RunEvent | null => {
    const c = spend.charged;
    const cum = {
      input: Math.max(c.input, u.inputTokens),
      output: Math.max(c.output, u.outputTokens),
      cacheRead: Math.max(c.cacheRead, u.cacheReadTokens ?? 0),
      cacheWrite: Math.max(c.cacheWrite, u.cacheWriteTokens ?? 0),
    };
    const usd = Math.max(
      c.usd,
      costUsd(model, cum.input, cum.output, { cacheReadTokens: cum.cacheRead, cacheWriteTokens: cum.cacheWrite }),
    );
    const d = { input: cum.input - c.input, output: cum.output - c.output, usd: usd - c.usd };
    spend.charged = { ...cum, usd };
    ctx.usage.totalInputTokens += d.input;
    ctx.usage.totalOutputTokens += d.output;
    ctx.usage.totalCostUsd += d.usd;
    spend.step.inputTokens += d.input;
    spend.step.outputTokens += d.output;
    spend.step.costUsd += d.usd;
    return enforceBudgets(ctx);
  };
  /** What the session spent since the last step ended — that step's cost. */
  const takeStepSpend = () => {
    const out = spend.step;
    spend.step = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    return out;
  };

  /** Gates approved so far, this leg or before (a resume's auto-approve). */
  const gatesApproved = (): Set<string> => new Set([...approvedGates, ...ctx.autoApproveLocks]);
  const checklist = (): string => progress.checklist(gatesApproved());
  const err = (text: string) => ({ text, isError: true });
  const stepRef = (s: HarnessStep) => (s.key === s.name ? `"${s.name}"` : `"${s.name}" (id "${s.key}")`);
  const nextLine = (): string => {
    if (halt.gate) return `The run is waiting for approval of ${stepRef(halt.gate)} — end your turn now.`;
    const avail = progress.available();
    if (avail.length === 0 && progress.unfinished().length === 0) {
      return 'All steps are done. End your turn with a short summary of the run.';
    }
    if (avail.length === 0) return `Finish ${progress.active ? stepRef(progress.active) : 'the active step'} first.`;
    const list = avail.map(s => `${stepRef(s)} (${kindLabel(s)})`);
    return progress.follow === 'strict'
      ? `Next: ${list.join(' or ')}.`
      : `Not done yet: ${list.join(', ')}.`;
  };

  /** Record a step's end: checkpoint, state, and what the run page shows.
   *  Returns what the engine decided as a result — a repeated loop's pass
   *  ending goes round again or finishes — for the tool's reply. */
  const finishStep = (s: HarnessStep, raw: StepRecord): string => {
    // Scrub BEFORE encoding: a secret with a quote or a newline is escaped
    // inside the JSON record, where the event scrubber's exact match misses it.
    const rec: StepRecord = {
      ...raw,
      ...(raw.output !== undefined ? { output: scrubSecrets(raw.output, ctx.injectedSecrets) } : {}),
      ...(raw.reason !== undefined ? { reason: scrubSecrets(raw.reason, ctx.injectedSecrets) } : {}),
    };
    const replayKey = progress.checkpointKey(s);
    stepBudget.leave(s);
    progress.finish(s, rec);
    const encoded = encodeStepRecord(rec);
    ctx.replayOutputs.set(replayKey, encoded);
    if (rec.status === 'done' && rec.by === 'harness') {
      ctx.lastOutput = rec.output ?? '';
      queue.push({
        type: 'phase-end',
        phaseName: s.name,
        output: rec.output ?? '',
        ...takeStepSpend(),
        durationMs: Date.now() - (startedAt.get(s.key) ?? Date.now()),
        model,
        ts: Date.now(),
      });
      if (applyAs(s.node, ctx)) queue.push({ type: 'state-set', key: s.node.as!, ts: Date.now() });
    } else if (rec.status === 'skipped') {
      queue.push({ type: 'phase-skipped', phaseName: s.name, reason: rec.reason ?? 'skipped', ts: Date.now() });
    } else if (rec.status === 'failed' && rec.by === 'harness') {
      queue.push({ type: 'phase-error', phaseName: s.name, error: rec.reason ?? 'failed', ...takeStepSpend(), ts: Date.now() });
    }
    queue.push({
      type: 'harness-step',
      key: s.key,
      phaseName: s.name,
      status: rec.status,
      by: rec.by ?? 'harness',
      ...(rec.reason ? { reason: rec.reason } : {}),
      record: encoded,
      replayKey,
      ts: Date.now(),
    });
    return s.loop && progress.passComplete(s.loop.name) ? endOfPass(s.loop) : '';
  };

  /** A repeated loop's pass is done: apply its rule, as a pipeline would —
   *  stop on `until` / once `whileOutput` is gone / at `maxIterations`, or
   *  open the steps for the next pass, framed as a refinement. */
  const endOfPass = (loop: NonNullable<HarnessStep['loop']>): string => {
    const pass = progress.passOf(loop.name);
    const output = ctx.lastOutput;
    const lower = output.toLowerCase();
    const stop =
      loop.until && lower.includes(loop.until.toLowerCase())
        ? `its output contains "${loop.until}"`
        : loop.whileOutput && !lower.includes(loop.whileOutput.toLowerCase())
          ? `its output no longer contains "${loop.whileOutput}"`
          : pass >= loop.max
            ? `it reached its limit of ${loop.max} passes`
            : null;
    if (stop) {
      const loopRecord = encodeStepRecord({ status: 'done', output, by: 'engine' });
      ctx.replayOutputs.set(HARNESS_CHECKPOINT_PREFIX + loop.name, loopRecord);
      queue.push({ type: 'loop-stopped', phaseName: loop.name, iteration: pass, reason: stop, ts: Date.now() });
      queue.push({
        type: 'harness-step',
        key: loop.name,
        phaseName: loop.name,
        status: 'done',
        by: 'engine',
        reason: stop,
        record: loopRecord,
        replayKey: HARNESS_CHECKPOINT_PREFIX + loop.name,
        ts: Date.now(),
      });
      if (applyAs(loop.node, ctx)) queue.push({ type: 'state-set', key: loop.node.as!, ts: Date.now() });
      return `"${loop.name}" is finished after pass ${pass}: ${stop}.`;
    }
    const next = progress.nextPass(loop.name);
    queue.push({ type: 'loop-iteration', phaseName: loop.name, iteration: next, ts: Date.now() });
    if (loop.carryContext) {
      ctx.lastOutput =
        `[Refinement iteration ${next} of ${loop.max}. You are continuing prior work that already exists ` +
        `(in the working tree / from the previous iteration) — do not start over. Apply only the changes ` +
        `needed to address the feedback below.]\n\n${output}`;
    }
    const why = loop.until
      ? `its output doesn't contain "${loop.until}"`
      : loop.whileOutput
        ? `its output still contains "${loop.whileOutput}"`
        : 'the loop has passes left';
    return `Pass ${pass} of "${loop.name}" is done, but ${why} — the engine opened pass ${next} of at most ${loop.max}.`;
  };

  /** The instructions start_step hands the agent. */
  const briefFor = (s: HarnessStep): string => {
    const input = ctx.lastOutput;
    const lookup = lookupState(ctx, input);
    const unresolved = new Set<string>();
    const note = (r: string) => unresolved.add(r);
    const index = steps.indexOf(s) + 1;
    const out: string[] = [`## Step ${index} of ${steps.length}: ${s.name}`];
    if (s.description) out.push(s.description);
    if (s.kind === 'engine') {
      out.push(
        `This step runs exactly as written (${s.engineKind ?? 'engine step'}). Call run_step("${s.key}") — ` +
          'it runs the step and returns its output; run_step also records it as done.',
      );
      return out.join('\n\n');
    }
    if (s.kind === 'task' && s.agentPath) {
      const path = resolveAgentPath(s.agentPath, lookup, note);
      const agent = ctx.agentByPath.get(path);
      if (agent) {
        const guidelines = interpolate(parseAgentBody(agent.raw).systemPrompt, lookup, note).trim();
        if (guidelines) out.push(`### Guidelines for this step (${path})\n${guidelines}`);
      } else {
        out.push(`(The step's agent file ${path} wasn't found — work from the task below.)`);
      }
    }
    if (s.kind === 'skill') out.push(`### How\nRun the skill "${s.skill}" with the Skill tool to do this step.`);
    if (s.node.prompt !== undefined) {
      out.push(`### Task\n${resolveAgentInput(s.node, input, lookup, note)}`);
      if (input.trim()) out.push(`### Output of the previous step\n${clipForAgent(input, 8_000)}`);
    } else {
      out.push(`### Task\nWork on this input, as the guidelines describe:\n\n${clipForAgent(input) || '(no input)'}`);
    }
    const gateMsgKey = [s.key, s.name, ...s.gates].find(k => k && ctx.gateMessages.has(k));
    if (gateMsgKey) {
      const msg = ctx.gateMessages.get(gateMsgKey)!;
      ctx.gateMessages.delete(gateMsgKey);
      if (msg.trim()) out.push(`### Instruction from the person who approved this step\n${msg.trim()}`);
    }
    const tools = toolsFor(s);
    const servers = Array.isArray(s.node.mcp) ? s.node.mcp : [];
    out.push(
      `### Tools for this step\n${tools.length > 0 ? tools.join(', ') : 'reading only (Read, Glob, Grep)'}` +
        (servers.length > 0 ? `; MCP servers: ${servers.join(', ')}` : ''),
    );
    const schema = s.node.output;
    out.push(
      schema && typeof schema === 'object'
        ? `### Output\nHand in JSON matching this schema with complete_step:\n${JSON.stringify(schema, null, 2)}`
        : '### Output\nHand in your result with complete_step — the next step receives it.',
    );
    if (unresolved.size > 0) {
      queue.push({ type: 'interpolation-unresolved', phaseName: s.name, refs: [...unresolved], ts: Date.now() });
    }
    return out.join('\n\n');
  };

  /** Cross each of a step's unapproved gates: record it, auto-approve it
   *  (unattended mode, or the gate a resume was approved at), or stop the
   *  leg there. Returns the tool reply when the run must stop. */
  const gateCheck = (s: HarnessStep, gates: string[]): { text: string } | null => {
    for (const g of gates) {
      if (approvedGates.has(g)) continue;
      queue.push({ type: 'lock-gate', phaseName: g, replayKey: g, ts: Date.now() });
      let approved = ctx.autoApproveAllLocks;
      if (!approved && ctx.autoApproveLocks.has(g)) {
        ctx.autoApproveLocks.delete(g);
        approved = true;
      }
      if (approved) {
        approvedGates.add(g);
        continue;
      }
      halt.gate = s;
      halt.gateName = g;
      return {
        text:
          `${stepRef(s)} needs a person's approval${g !== s.name ? ` ("${g}")` : ''} before it starts. STOP NOW: ` +
          'end your turn with a one-line status. The run pauses here; once it is approved you are resumed at this step.',
      };
    }
    return null;
  };

  const findStep = (ref: string | undefined) =>
    ref ? progress.find(ref) : undefined;
  const noSuchStep = (ref: string | undefined) =>
    err(`There is no step "${ref ?? ''}". The steps:\n${checklist()}`);

  const tools: HarnessToolSpec[] = [
    {
      name: 'list_steps',
      description: 'The run\'s steps, what each one needs, and which are done.',
      params: {},
      handler: async () => ({ text: `${checklist()}\n\n${nextLine()}` }),
    },
    {
      name: 'start_step',
      description:
        'Start a step. The engine checks the order and returns the step\'s instructions, input and tools. ' +
        'A step that needs approval stops the run until a person approves it.',
      params: { step: 'The step id or name.' },
      handler: async args => {
        const s = findStep(args.step);
        if (!s) return noSuchStep(args.step);
        if (halt.gate || halt.stop) return err(nextLine());
        if (progress.active?.key === s.key) return { text: briefFor(s) };
        const verdict = progress.canStart(s);
        if (!verdict.ok) return err(verdict.reason);
        const wasFinished = progress.statusOf(s.key) === 'done' || progress.statusOf(s.key) === 'skipped';
        // A pipeline enters an enclosing locked section before it looks at a
        // step's `when`, and checks a step's own lock after it — same here.
        const ownLock = s.node.lock ? s.name : null;
        const stopped = gateCheck(s, s.gates.filter(g => g !== ownLock));
        if (stopped) return stopped;
        if (s.node.when !== undefined) {
          const refs = new Set<string>();
          const run = evalWhen(s.node.when, lookupState(ctx, ctx.lastOutput), r => refs.add(r));
          if (refs.size > 0 || !run) {
            const reason =
              refs.size > 0
                ? `its condition references unresolved \${...}: ${[...refs].join(', ')} — treated as false`
                : `its condition "${s.node.when}" is false`;
            if (refs.size > 0) {
              queue.push({ type: 'interpolation-unresolved', phaseName: s.name, refs: [...refs], ts: Date.now() });
            }
            const note = finishStep(s, { status: 'skipped', reason, by: 'when' });
            return { text: `The engine skipped ${stepRef(s)}: ${reason}.${note ? ` ${note}` : ''}\n\n${nextLine()}` };
          }
        }
        const ownStopped = gateCheck(s, ownLock ? [ownLock] : []);
        if (ownStopped) return ownStopped;
        progress.start(s);
        if (s.kind !== 'engine') stepBudget.enter(s);
        if (wasFinished) reopened.add(s.key);
        startedAt.set(s.key, Date.now());
        queue.push({ type: 'phase-start', phaseName: s.name, ts: Date.now() });
        queue.push({ type: 'harness-step', key: s.key, phaseName: s.name, status: 'started', by: 'harness', ts: Date.now() });
        return { text: briefFor(s) };
      },
    },
    {
      name: 'complete_step',
      description: 'Hand in the active step\'s result. Engine steps finish with run_step instead.',
      params: { step: 'The step id or name.', output: 'The step\'s result, as the step asks for it.' },
      handler: async args => {
        const s = findStep(args.step);
        if (!s) return noSuchStep(args.step);
        if (progress.active?.key !== s.key) {
          return err(
            `${stepRef(s)} isn't in progress` +
              (progress.active ? ` — ${stepRef(progress.active)} is.` : ' — start it with start_step first.'),
          );
        }
        if (s.kind === 'engine') return err(`${stepRef(s)} is an engine step: call run_step("${s.key}").`);
        const output = scrubSecrets(args.output ?? '', ctx.injectedSecrets);
        const contract = checkContract(s.node.output, output);
        if (contract.enforce && !contract.ok) {
          return err(`The output ${contract.reason}. Fix it and call complete_step again.`);
        }
        const note = finishStep(s, { status: 'done', output, by: 'harness' });
        return { text: `Recorded ${stepRef(s)} as done.${note ? ` ${note}` : ''}\n\n${nextLine()}` };
      },
    },
    {
      name: 'fail_step',
      description: 'Record that you could not do the active step, and why.',
      params: { step: 'The step id or name.', reason: 'Why it could not be done.' },
      handler: async args => {
        const s = findStep(args.step);
        if (!s) return noSuchStep(args.step);
        if (progress.active?.key !== s.key) return err(`${stepRef(s)} isn't in progress.`);
        const reason = (args.reason ?? '').trim() || 'no reason given';
        const note = finishStep(s, { status: 'failed', reason, by: 'harness' });
        return {
          text: s.required
            ? `Recorded ${stepRef(s)} as failed. It is required, so the run can't finish while it has failed: ` +
              'start it again to retry, or end your turn and the run ends with this failure.'
            : `Recorded ${stepRef(s)} as failed. It is optional, so the run continues (marked degraded).${note ? ` ${note}` : ''}\n\n${nextLine()}`,
        };
      },
    },
    {
      name: 'skip_step',
      description: 'Advisory runs only: skip a step, saying why. The run is marked degraded, naming it.',
      params: { step: 'The step id or name.', reason: 'Why the step is being skipped.' },
      handler: async args => {
        const s = findStep(args.step);
        if (!s) return noSuchStep(args.step);
        if (progress.follow !== 'advisory') {
          return err(
            `Skipping isn't allowed: this run follows ${progress.follow === 'strict' ? 'strict' : 'loose'} order. ` +
              'If the step can\'t be done, use fail_step.',
          );
        }
        const reason = (args.reason ?? '').trim();
        if (!reason) return err('Say why the step is being skipped.');
        const st = progress.statusOf(s.key);
        if (st === 'done' || st === 'skipped') return err(`${stepRef(s)} is already ${st}.`);
        if (progress.active && progress.active.key !== s.key) return err(`Finish ${stepRef(progress.active)} first.`);
        const note = finishStep(s, { status: 'skipped', reason, by: 'harness' });
        return { text: `Skipped ${stepRef(s)}.${note ? ` ${note}` : ''}\n\n${nextLine()}` };
      },
    },
    {
      name: 'run_step',
      description: 'Run the active engine step exactly as written and return its output.',
      params: { step: 'The step id or name.' },
      handler: async args => {
        const s = findStep(args.step);
        if (!s) return noSuchStep(args.step);
        if (progress.active?.key !== s.key) return err(`${stepRef(s)} isn't in progress — start it with start_step first.`);
        if (s.kind !== 'engine') return err(`${stepRef(s)} is yours to do (${kindLabel(s)}); complete_step it when done.`);
        // start_step already decided the gate and the condition.
        const node: Node = { ...s.node, lock: false, when: undefined };
        // Each pass of a repeated loop — and a loose-order redo — runs the
        // step afresh: its leaves checkpoint under their own scope, so they
        // don't replay what the previous pass recorded.
        const scope = s.loop
          ? `${s.loop.name}@${progress.passOf(s.loop.name)}`
          : reopened.has(s.key)
            ? `${s.key}~redo${Date.now()}`
            : '';
        const stepCtx: ExecutorContext = scope
          ? { ...ctx, replayScope: ctx.replayScope ? `${ctx.replayScope}/${scope}` : scope }
          : ctx;
        // Don't hold an agent slot while the engine step may need one. (A
        // terminal-driven leg holds none.)
        const heldSlot = slot.release !== null;
        slot.release?.();
        slot.release = null;
        engine.running = true;
        try {
          for await (const ev of executeNode(node, stepCtx, ctx.lastOutput)) queue.push(ev);
          if (stepCtx !== ctx) {
            ctx.lastOutput = stepCtx.lastOutput;
            ctx.lastOutputValue = stepCtx.lastOutputValue;
          }
        } catch (e) {
          if (e instanceof RunPauseRequested || e instanceof RunCancelled || e instanceof BudgetExceededError) {
            halt.stop = e;
            releaseActive();
            return { text: 'The run is stopping here. End your turn now with a one-line status.' };
          }
          const reason = (e as Error).message;
          finishStep(s, { status: 'failed', reason, by: 'engine' });
          return err(
            `${stepRef(s)} failed: ${reason}` +
              (s.required
                ? '\n\nIt is required: start it again to retry, or end your turn and the run ends with this failure.'
                : `\n\nIt is optional, so the run continues.\n\n${nextLine()}`),
          );
        } finally {
          engine.running = false;
          if (heldSlot && legLive.v && !ctx.cancelled.v) {
            await acquireSlot();
            // The leg ended while we waited for the slot: give it straight back.
            if (!(legLive.v as boolean) || ctx.cancelled.v) {
              (slot.release as (() => void) | null)?.();
              slot.release = null;
            }
          }
          if (engine.interruptPending) {
            engine.interruptPending = false;
            // Only if the takeover is still wanted (it may have timed out).
            if (control?.wantTerminal) requestInterrupt();
          }
        }
        reopened.delete(s.key);
        const output = ctx.lastOutput;
        const note = finishStep(s, { status: 'done', output, by: 'engine' });
        return {
          text: `${stepRef(s)} finished. Its output:\n\n${clipForAgent(scrubSecrets(output, ctx.injectedSecrets))}${note ? `\n\n${note}` : ''}\n\n${nextLine()}`,
        };
      },
    },
  ];

  /** Asked before every tool call in the session. */
  const toolGate = (toolName: string, input: unknown): string | null => {
    if (toolName.startsWith(`mcp__${HARNESS_TOOL_SERVER}__`)) return null;
    if (halt.gate || halt.stop) return nextLine();
    if (HARNESS_ALWAYS_ALLOWED.includes(toolName)) return null;
    const s = progress.active;
    if (!s) return 'No step is in progress. Start one with start_step — between steps only reading works.';
    if (s.kind === 'engine') return `${stepRef(s)} is an engine step: call run_step("${s.key}") instead of doing it yourself.`;
    if (toolName === 'Skill') {
      if (s.kind !== 'skill') return `${stepRef(s)} doesn't run a skill.`;
      const wanted = (input as { skill?: unknown } | null)?.skill;
      const named = s.skill!;
      if (typeof wanted === 'string' && wanted !== named && !(named.includes(':') && named.endsWith(`:${wanted}`))) {
        return `${stepRef(s)} runs the skill "${s.skill}", not "${wanted}".`;
      }
      return null;
    }
    if (toolName.startsWith('mcp__')) {
      const server = toolName.split('__')[1];
      const servers = Array.isArray(s.node.mcp) ? s.node.mcp : [];
      return servers.includes(server) ? null : `${stepRef(s)} doesn't use the MCP server "${server}".`;
    }
    const allowed = toolsFor(s);
    // A declared `Tool(pattern)` (Claude Code's permission syntax) allows the
    // tool for matching calls; for Bash the pattern is the command (`x:*` /
    // `x*` = starts with x, else exactly x). Other tools' patterns aren't
    // checked here — the tool itself is allowed.
    const patterns = allowed
      .map(t => /^([A-Za-z]+)\((.*)\)$/.exec(t))
      .filter((m): m is RegExpExecArray => !!m && m[1] === toolName)
      .map(m => m[2]);
    if (!allowed.includes(toolName)) {
      if (patterns.length === 0) {
        return `${stepRef(s)} doesn't allow ${toolName}. It allows: ${allowed.length > 0 ? allowed.join(', ') : 'reading only'}.`;
      }
      if (toolName === 'Bash') {
        const cmd = String((input as { command?: unknown } | null)?.command ?? '').trim();
        const ok = patterns.some(p => {
          const prefix = p.endsWith(':*') ? p.slice(0, -2) : p.endsWith('*') ? p.slice(0, -1) : null;
          return prefix !== null ? cmd.startsWith(prefix.trim()) : cmd === p.trim();
        });
        if (!ok) return `${stepRef(s)} only allows Bash for: ${patterns.join(', ')}.`;
      }
    }
    if (toolName === 'Bash') {
      const cmd = (input as { command?: unknown } | null)?.command;
      const hit = typeof cmd === 'string' ? checkDeniedCommand(cmd, effectiveSandboxFor(s.name, ctx.sandboxByPhase)) : null;
      if (hit) {
        queue.push({ type: 'tools-warning', phaseName: s.name, missing: [`sandbox-refused:${hit}`], ts: Date.now() });
        return `This step's sandbox refuses commands containing "${hit}". Do it another way, or say why it can't be done without it.`;
      }
    }
    return null;
  };

  // ── Legs ──
  const input = String(ctx.state.input ?? '');
  const firstMessage = (): string => {
    if (!resumeSession) {
      return restored.size > 0
        ? `This run is resuming in a new session (the previous one couldn't be continued). Steps already ` +
            `finished are checked in the list.\n\nThe last finished step's output:\n${clipForAgent(ctx.lastOutput, 8_000) || '(none)'}\n\n${nextLine()}`
        : `Begin the run.\n\nThe run's input:\n${clipForAgent(input) || '(none)'}\n\n${nextLine()}`;
    }
    const approved = steps.find(s => s.gates.some(g => ctx.autoApproveLocks.has(g)));
    if (approved) {
      return `${stepRef(approved)} was approved. Continue the run: start_step("${approved.key}").`;
    }
    return `The run was paused and has resumed. Where it stands:\n${checklist()}\n\n${nextLine()}`;
  };
  let message = firstMessage();
  const stallSeconds = Math.max(
    envSeconds('SAMMY_DEFAULT_STALL_TIMEOUT_SEC', DEFAULT_STALL_TIMEOUT_SEC),
    orchestration.defaults?.stallTimeout ?? 0,
    maxStallTimeoutInSubtree(orchestration, ctx.orchestrationByName) ?? 0,
  );
  const extra = orchestration.harness?.instructions;
  let nudges = 0;
  let triedFreshSession = false;

  /** A gate a leg stopped at: pause for approval (the server pauses the
   *  run here), then tell the agent it was approved. */
  const awaitGate = async (gateStep: HarnessStep): Promise<void> => {
    const gate = (halt.gateName as string | null) ?? gateStep.gates[gateStep.gates.length - 1];
    const approved = await ctx.waitForApproval(gate, gate);
    if (!approved) {
      ctx.cancelled.v = true;
      throw new RunCancelled();
    }
    approvedGates.add(gate);
    message = `${stepRef(gateStep)} was approved. Continue the run: start_step("${gateStep.key}").`;
  };

  yield { type: 'phase-start', phaseName: HARNESS_PHASE, ts: Date.now() };
  // A restart that landed between a pass's last step and the loop's rule
  // being applied: apply it now, before the agent picks the next step.
  for (const loop of new Map(steps.flatMap(s => (s.loop ? [[s.loop.name, s.loop] as const] : []))).values()) {
    if (progress.passComplete(loop.name) && !record(loop.name)) endOfPass(loop);
  }
  queue.close();
  for await (const ev of queue.drain()) yield ev;
  for (let leg = 1; ; leg++) {
    if (leg > HARNESS_MAX_LEGS) {
      throw new Error(`The harness used ${HARNESS_MAX_LEGS} session legs without finishing — stopping it.`);
    }
    const byTerminal = control?.wantTerminal === true && control.serveTools !== null;
    yield {
      type: 'harness-start',
      follow: resolved.follow,
      followSource: resolved.source,
      ...(resolved.refused ? { followRefused: resolved.refused } : {}),
      steps: steps.map(s => ({
        key: s.key,
        name: s.name,
        kind: s.kind,
        rank: s.rank,
        ...(s.skill ? { skill: s.skill } : {}),
        ...(s.engineKind ? { engineKind: s.engineKind } : {}),
        ...(s.gates.length > 0 ? { gates: s.gates } : {}),
        ...(s.group ? { group: s.group } : {}),
        ...(s.section ? { section: s.section } : {}),
        ...(s.loop ? { loop: s.loop.name, loopMax: s.loop.max, pass: progress.passOf(s.loop.name) } : {}),
        required: s.required,
        finally: s.finally,
      })),
      sessionId,
      ...(cwd ? { cwd } : {}),
      model,
      leg,
      driver: byTerminal ? 'terminal' : 'server',
      ts: Date.now(),
    };

    queue = new HarnessEventQueue<RunEvent>();
    const legQueue = queue;
    halt.gate = null;
    halt.gateName = null;
    halt.stop = null;

    // ── A terminal drives this leg: serve the step tools to it and follow
    //    along until it finishes, stops at a gate, hands back, or goes idle.
    if (byTerminal && control) {
      const end: { why: 'handback' | 'idle' | 'auto' | 'cancel' | null } = { why: null };
      // A tool call in flight (a long run_step) holds the leg open: idle
      // isn't counted during it, and a hand-back or a finish waits for it —
      // else its result would land after the leg closed and never checkpoint.
      const calls = { inFlight: 0, deferred: null as 'handback' | 'idle' | 'auto' | null };
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idleSec = envSeconds('SAMMY_HARNESS_TERMINAL_IDLE_SEC', HARNESS_TERMINAL_IDLE_SEC);
      const finish = (why: 'handback' | 'idle' | 'auto' | 'cancel'): void => {
        if (end.why) return;
        if (why !== 'cancel' && calls.inFlight > 0) {
          calls.deferred ??= why;
          return;
        }
        end.why = why;
        if (idleTimer) clearTimeout(idleTimer);
        legQueue.close();
      };
      const bumpIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish('idle'), idleSec * 1000);
        (idleTimer as unknown as { unref?: () => void }).unref?.();
      };
      const served = await control.serveTools!(
        tools.map(t => ({
          ...t,
          handler: async (args: Record<string, string | undefined>) => {
            if (end.why) return { text: 'The terminal no longer drives this run.', isError: true };
            calls.inFlight += 1;
            if (idleTimer) clearTimeout(idleTimer);
            try {
              const res = await t.handler(args);
              if (halt.gate || halt.stop || (!progress.active && progress.unfinished().length === 0)) {
                calls.deferred ??= 'auto';
              }
              return res;
            } finally {
              calls.inFlight -= 1;
              if (calls.inFlight === 0) {
                const why = calls.deferred;
                calls.deferred = null;
                if (why) finish(why);
                else bumpIdle();
              }
            }
          },
        })),
      );
      control.terminal = { url: served.url, token: served.token, sessionId, ...(cwd ? { cwd } : {}) };
      control.endTerminalLeg = why => finish(why);
      const cancelWatch = setInterval(() => {
        if (ctx.cancelled.v) finish('cancel');
      }, 500);
      (cancelWatch as unknown as { unref?: () => void }).unref?.();
      yield {
        type: 'harness-notice',
        message: 'A person is driving the run from a terminal; the engine still checks the order and holds the gates.',
        ts: Date.now(),
      };
      bumpIdle();
      try {
        for await (const ev of legQueue.drain()) yield ev;
      } finally {
        clearInterval(cancelWatch);
        if (idleTimer) clearTimeout(idleTimer);
        served.close();
        control.terminal = null;
        control.endTerminalLeg = null;
      }
      resumeSession = true;
      control.wantTerminal = false;
      if (end.why === 'cancel' || ctx.cancelled.v) throw new RunCancelled();
      if (end.why === 'handback') {
        releaseActive();
        yield { type: 'harness-notice', message: 'The terminal handed the run back to the server\'s agent.', ts: Date.now() };
        message =
          `The person driving the run from a terminal has handed it back to you. Where it stands:\n` +
          `${checklist()}\n\n${nextLine()}`;
        continue;
      }
      if (end.why === 'idle') {
        releaseActive();
        yield {
          type: 'harness-notice',
          message: `No step tool was called from the terminal for ${Math.round(idleSec / 60)} minutes — pausing the run. Resume it, or take it over again.`,
          ts: Date.now(),
        };
        throw new RunPauseRequested(HARNESS_PHASE);
      }
      const stopped = halt.stop as Error | null;
      if (stopped) {
        releaseActive();
        throw stopped;
      }
      const gated = halt.gate as HarnessStep | null;
      if (gated) {
        await awaitGate(gated);
        continue;
      }
      if (progress.unfinished().length === 0) break;
      continue;
    }

    // ── The server's agent drives this leg.
    let legText = '';
    let sawChunk = false;
    let hitMaxTurns = false;
    let interruptedLeg = false;
    let legError: Error | null = null;
    // This leg's step tools and tool gate answer only while the leg is open. A
    // leg that ends early (a takeover, a stall, a budget stop, a cancel) closes
    // its session's stream, but the session can still be finishing a turn: a
    // step tool it calls then is refused, so it can't move the run while the
    // next driver (a terminal, the next leg) has it.
    const thisLeg = { open: true };
    const legOpen = (): boolean => thisLeg.open && !engine.interrupted;
    const legEnded =
      "This session's leg has ended: the run is being driven elsewhere or has stopped. End your turn now, without calling more tools.";
    const harnessOpts: HarnessStreamOptions = {
      tools: tools.map(t => ({
        ...t,
        handler: async (args: Record<string, string | undefined>) =>
          legOpen() ? t.handler(args) : { text: legEnded, isError: true },
      })),
      ...(resumeSession ? { resume: sessionId } : { sessionId }),
      ...(skills.length > 0 ? { skills } : {}),
      toolGate: (toolName: string, toolInput: unknown) => (legOpen() ? toolGate(toolName, toolInput) : legEnded),
    };
    const system = buildHarnessSystemPrompt({ orchestration, progress, extra, approvedGates: gatesApproved() }) + PHASE_TURN_CONTRACT;
    const prompt = message;

    await acquireSlot();
    if (ctx.cancelled.v) {
      slot.release?.();
      throw new RunCancelled();
    }
    engine.interrupted = false;
    legLive.v = true;
    spend.charged = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
    if (control) {
      control.interruptLeg = requestInterrupt;
      // A takeover asked for between legs: hand over at the first event.
      if (control.wantTerminal) requestInterrupt();
    }
    const legEvents = async function* (): AsyncIterable<RunEvent> {
      const chunks = (async function* () {
        try {
          for await (const ev of ctx.streamFn({
            apiKey: ctx.apiKey,
            model,
            system,
            messages: [{ role: 'user', content: prompt }],
            tools: [...sessionTools],
            permissionMode: 'bypassPermissions',
            ...(autoApprove.length > 0 ? { autoApproveTools: autoApprove } : {}),
            ...(mcpServers.length > 0 ? { mcp: mcpServers } : {}),
            ...(hookNames.length > 0 ? { hooks: hookNames } : {}),
            maxTurns: orchestration.harness?.maxTurns ?? 1000,
            ...(orchestration.defaults?.maxAgentTokens !== undefined
              ? { maxAgentTokens: orchestration.defaults.maxAgentTokens }
              : {}),
            env: {
              ...(ctx.runId ? { SAMMY_RUN_ID: ctx.runId } : {}),
              ...ctx.worktreeEnv,
              ...credEnv,
              MCP_TOOL_TIMEOUT: HARNESS_TOOL_TIMEOUT_MS,
              CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: HARNESS_TOOL_TIMEOUT_MS,
            },
            ...(cwd ? { cwd } : {}),
            harness: harnessOpts,
          })) {
            yield { from: 'agent' as const, ev };
          }
        } finally {
          legQueue.close();
        }
      })();
      const queued = (async function* () {
        for await (const ev of legQueue.drain()) yield { from: 'engine' as const, ev };
      })();
      for await (const item of mergeIterators<{ from: 'agent'; ev: StreamEvent } | { from: 'engine'; ev: RunEvent }>([chunks, queued])) {
        if (ctx.cancelled.v) throw new RunCancelled();
        if (item.from === 'engine') {
          yield item.ev;
          if (engine.interrupted) throw new HarnessLegInterrupted();
          continue;
        }
        sawChunk = true;
        const ev = item.ev;
        const phaseName = progress.active?.name ?? HARNESS_PHASE;
        if (ev.type === 'text-delta') {
          legText += ev.text;
          yield { type: 'phase-delta', phaseName, text: ev.text, ts: Date.now() };
        } else if (ev.type === 'tool-use') {
          yield { type: 'phase-tool-use', phaseName, toolName: ev.name, toolUseId: ev.toolUseId, input: ev.input, ts: Date.now() };
        } else if (ev.type === 'tool-result') {
          yield { type: 'phase-tool-result', phaseName, toolUseId: ev.toolUseId, output: ev.output, isError: ev.isError, ts: Date.now() };
        } else if (ev.type === 'compaction') {
          yield {
            type: 'phase-compacted',
            phaseName,
            trigger: ev.trigger,
            preTokens: ev.preTokens,
            ...(ev.postTokens !== undefined ? { postTokens: ev.postTokens } : {}),
            ts: Date.now(),
          };
        } else if (ev.type === 'heartbeat') {
          yield {
            type: 'phase-heartbeat',
            phaseName,
            via: ev.via,
            messages: ev.messages,
            toolUses: ev.toolUses,
            textBytes: ev.textBytes,
            ts: Date.now(),
          };
        } else if (ev.type === 'usage' || ev.type === 'done') {
          const breach = chargeUsage(ev.usage);
          if (breach) {
            yield breach;
            const b = breach as Extract<RunEvent, { type: 'budget-exceeded' }>;
            throw new BudgetExceededError(b.kind, b.limit, b.actual);
          }
        }
        if (engine.interrupted) throw new HarnessLegInterrupted();
      }
    };

    try {
      for await (const ev of withStallGuard(legEvents(), HARNESS_PHASE, stallSeconds)) yield ev;
    } catch (e) {
      // A session that died mid-turn still spent what it reports.
      const dead = usageOf(e);
      if (dead) chargeUsage(dead);
      if (e instanceof HarnessLegInterrupted) {
        interruptedLeg = true;
      } else if (e instanceof RunCancelled) {
        legError = e;
      } else if (/Reached maximum number of turns/i.test((e as Error).message)) {
        hitMaxTurns = true;
      } else {
        legError = e as Error;
      }
    } finally {
      thisLeg.open = false;
      legLive.v = false;
      if (control) control.interruptLeg = null;
      slot.release?.();
      slot.release = null;
      legQueue.close();
    }
    // Whatever the step tools queued after the agent's stream ended.
    for await (const ev of legQueue.drain()) yield ev;

    // What the session spent since the last step ended is the harness's own
    // (between-step) spend: on the leg's phase-end, so every dollar lands on
    // exactly one event.
    const rest = takeStepSpend();
    if (rest.inputTokens + rest.outputTokens > 0 || rest.costUsd > 0 || legText) {
      yield {
        type: 'phase-end',
        phaseName: HARNESS_PHASE,
        output: scrubSecrets(legText, ctx.injectedSecrets),
        ...rest,
        durationMs: 0,
        model,
        ts: Date.now(),
      };
    }
    yield {
      type: 'cost',
      costUsd: ctx.usage.totalCostUsd,
      inputTokens: ctx.usage.totalInputTokens,
      outputTokens: ctx.usage.totalOutputTokens,
      ts: Date.now(),
    };
    if (legError instanceof BudgetExceededError) throw legError;

    if (legError instanceof RunCancelled) throw legError;
    const stop = halt.stop as Error | null;
    if (stop) {
      releaseActive();
      throw stop;
    }
    if (interruptedLeg) {
      // The next leg is the terminal's (control.wantTerminal is set).
      releaseActive();
      resumeSession = true;
      message = `The run is back with you. Where it stands:\n${checklist()}\n\n${nextLine()}`;
      continue;
    }
    if (legError) {
      // A session that can't be resumed (another machine, a cleared
      // ~/.claude) fails before it says anything: start a new one, once.
      if (resumeSession && !sawChunk && !triedFreshSession) {
        triedFreshSession = true;
        yield {
          type: 'harness-notice',
          message: `The harness session ${sessionId} couldn't be resumed (${legError.message}); continuing in a new session.`,
          ts: Date.now(),
        };
        sessionId = newHarnessSessionId();
        resumeSession = false;
        yield recordSession();
        message = firstMessage();
        continue;
      }
      releaseActive();
      throw legError;
    }
    resumeSession = true;

    const gateStep = halt.gate as HarnessStep | null;
    if (gateStep) {
      await awaitGate(gateStep);
      continue;
    }
    if (hitMaxTurns) {
      message = 'You reached the turn limit for one session leg. Continue where you left off.';
      continue;
    }
    const failedRequired = steps.filter(s => s.required && progress.statusOf(s.key) === 'failed');
    if (failedRequired.length > 0 && !progress.active) {
      throw new Error(
        'Harness: required step(s) failed — ' +
          failedRequired.map(s => `"${s.name}": ${progress.recordOf(s.key)?.reason ?? 'failed'}`).join('; '),
      );
    }
    const unfinished = progress.unfinished();
    if (unfinished.length === 0) break;
    nudges += 1;
    const open = unfinished.map(s => `"${s.name}"`).join(', ');
    if (nudges > HARNESS_MAX_NUDGES) {
      releaseActive();
      throw new Error(`The harness agent stopped with steps not done: ${open}.`);
    }
    yield {
      type: 'harness-notice',
      message: `The harness agent ended its turn with steps not done (${open}); telling it to continue (${nudges}/${HARNESS_MAX_NUDGES}).`,
      ts: Date.now(),
    };
    message = progress.active
      ? `You ended your turn while ${stepRef(progress.active)} is still in progress. Finish it with complete_step ` +
        '(or fail_step it if it can\'t be done), then continue.'
      : `You ended your turn, but the run isn't finished. ${nextLine()}`;
  }

  const skipped = progress.skippedByHarness();
  if (skipped.length > 0) {
    yield {
      type: 'harness-notice',
      message: `Finished with steps skipped by the harness: ${skipped.map(s => `"${s.name}"`).join(', ')}.`,
      ts: Date.now(),
    };
  }
  // The run's output is the last finished step's — what a pipeline run returns.
  const last = [...steps].reverse().find(s => progress.recordOf(s.key)?.status === 'done');
  if (last) ctx.lastOutput = progress.recordOf(last.key)?.output ?? ctx.lastOutput;
}

export async function* runOrchestration({
  orchestration,
  apiKey,
  model,
  streamFn,
  initialInput,
  waitForApproval,
  cancelled,
  configuredTools,
  allowAgentTools,
  enforcesDeniedCommands,
  paused,
  chatQueue,
  agentsOverride,
  orchestrationsOverride,
  replayOutputs,
  autoApproveLocks,
  gateMessages,
  pendingWaits,
  deliveredSignals,
  durableWaits,
  providerStreamFns,
  credentialsByName,
  credentialsRaw,
  injectedSecrets,
  resolvedInputs,
  runId,
  worktrees,
  loadArtifact,
  seedArtifacts,
  harnessSupported,
  harnessFollow,
  skillExists,
  harnessCwd,
  harnessControl,
}: {
  orchestration: Node;
  apiKey: string;
  model: string;
  /** LLM adapter to use. Defaults to `streamAnthropic` (direct API key
   *  path) for back-compat. Pass `streamClaudeCode` to route through the
   *  dev-server proxy using Claude Code CLI auth. */
  streamFn?: StreamFn;
  initialInput?: string;
  /** Resolved run inputs (name → content), seeded into state as ${name}
   *  before phase 1. Produced by the server-side input resolver from the
   *  orchestration's declared `inputs`. */
  resolvedInputs?: Record<string, string>;
  /** Human-gate callback. `phaseName` is the gated node's bare display name;
   *  the optional `scopedKey` is that gate INSTANCE's iteration-scoped key
   *  (the lock-gate event's `replayKey`) for callers that want to key an
   *  approval on the exact map/loop iteration. Implementations may ignore
   *  the 2nd arg — a 1-arg callback remains assignable. */
  waitForApproval: (phaseName: string, scopedKey?: string) => Promise<boolean>;
  cancelled: { v: boolean };
  /** Set of connector ids configured in the workspace. Used to validate
   *  `tools` declarations on agent nodes at run start. Defaults to empty,
   *  which produces only warnings. */
  configuredTools?: Set<string>;
  /** When true, agent-declared tools[] (Bash / Read / etc.) get
   *  forwarded to the LLM via the proxy. Off by default. */
  allowAgentTools?: boolean;
  /** The stream adapter refuses a denied Bash command itself (before it
   *  runs) — the backstop then records the refusal instead of failing the
   *  phase. Set by the server runner, whose SDK path installs the hook. */
  enforcesDeniedCommands?: boolean;
  /** Mutable pause flag. Set v=true to halt the orchestration at the
   *  next exchange boundary; set v=false to resume. Defaults to never
   *  pausing if omitted. */
  paused?: { v: boolean };
  /** Chat queue for user-injected messages. UI pushes to this; the
   *  executor drains between exchanges. Defaults to an empty queue. */
  chatQueue?: PhaseChatQueue;
  /** Pre-loaded agent files. When provided, the executor skips its
   *  default `listAgents()` HTTP call. Required when running outside
   *  the browser (server-side executor, CLI, tests). */
  agentsOverride?: AgentFile[];
  /** Pre-loaded orchestrations for subflow lookup. Same role as
   *  agentsOverride — server-side runs supply this directly from
   *  disk instead of letting the executor self-fetch. */
  orchestrationsOverride?: Node[];
  /** Skip-replay table: phase name → captured output from a prior
   *  run. When a leaf agent's name appears, runAgentPhase yields the
   *  stored output instead of calling the SDK. Used by resume-on-pause
   *  + future crash-resume so a run picks up from a checkpoint without
   *  re-dispatching already-completed work. The executor also populates
   *  the table LIVE as leaves succeed, so an in-process re-run of an
   *  enclosing composite (retry / onStall) replays completed children
   *  exactly like a resume would instead of re-executing them. */
  replayOutputs?: Record<string, string>;
  /** Names of `lock: true` phases that should auto-approve. Used by
   *  resume so the lock the user already approved (by clicking Resume)
   *  doesn't fire again on the re-walk. Empty for fresh runs. */
  autoApproveLocks?: string[];
  /** Human gate corrections, phase name → free-text instruction, seeded
   *  when a paused lock gate is approved WITH a message. The named
   *  phase's agent receives it appended to its input. Empty for fresh
   *  runs and plain resumes. */
  gateMessages?: Record<string, string>;
  /** Unresolved `wait` specs from a prior leg, keyed by the wait instance's
   *  iteration-scoped replay key. Seeded on resume from durable
   *  `wait-started` events (server/wait-resolution.ts) so a re-crossed wait
   *  re-parks against its ORIGINAL deadline instead of re-arming the clock.
   *  Empty for fresh runs. */
  pendingWaits?: Record<string, PendingWaitSpec>;
  /** Buffered external-signal payloads (name → FIFO queue), seeded on resume
   *  from durable `signal-received` events minus already-consumed
   *  deliveries. A `wait.signal` leaf consumes one payload as its output. */
  deliveredSignals?: Record<string, string[]>;
  /** Server-owned runs set true: a `wait` leaf that must actually wait then
   *  snapshots + pauses (RunPauseRequested) instead of sleeping in-process,
   *  so the park is durable and costs nothing. Default false (in-memory
   *  timer sleeps; signal waits with no buffered delivery fail loudly). */
  durableWaits?: boolean;
  /** Per-provider stream functions keyed by provider id. Lets a node
   *  with `provider: "openai"` route through OpenAI for that phase
   *  only while the rest of the run keeps using the caller's default
   *  `streamFn`. Unset = no per-provider routing (current behavior). */
  providerStreamFns?: ProviderRegistry;
  /** Credentials registry: map of credential NAME → secret value.
   *  When a node sets both `provider` and `credential`, the executor
   *  uses that credential's value as the API key for that phase
   *  only. Unset = no per-node credential routing. */
  credentialsByName?: Record<string, string>;
  /** Credentials registry: map of credential NAME → FULL entry (kind,
   *  fields, …). Used to project a phase's `credential`/`credentials`
   *  onto subprocess env vars by kind. Unset = no env injection. */
  credentialsRaw?: Record<string, import('../server/credentials-store').Credential>;
  /** Run-scoped set collecting every plaintext secret injected into an
   *  agent subprocess this run, for downstream scrubbing. A fresh Set is
   *  created when omitted (anonymous runs that don't scrub). */
  injectedSecrets?: Set<string>;
  /** Owning run id, recorded on each leaf's concurrency-queue waiter so
   *  the Queue view can attribute a blocked dispatch to its run (and the
   *  reorder API can target a run's waiters). Unset for in-browser /
   *  CLI runs that have no server-assigned id — they just queue
   *  anonymously. */
  runId?: string;
  /** Worktrees the server prepared for this run (root `worktrees` block —
   *  see server/worktrees.ts). Exposed as `${worktrees.<name>.path}` /
   *  `.branch`, as `SAMMY_WORKTREE_<NAME>` in every agent / code.run
   *  subprocess env, and — when there is exactly ONE — as the working
   *  directory of agents and code.run, so an edit lands in the run's tree
   *  and never in the server's checkout. */
  worktrees?: Array<{ name: string; path: string; branch: string; base: string; repo: string; reused?: boolean }>;
  /** Fetch an artifact an earlier leg of this run recorded (server-owned
   *  runs; see ExecutorContext.loadArtifact). */
  loadArtifact?: (
    name: string,
  ) => Promise<{ text: string; mediaType: string; dropped?: boolean } | undefined>;
  /** Artifacts to carry in (a fork's replayed leaves): re-emitted at run
   *  start so they are part of THIS run's record, and uploadable. */
  seedArtifacts?: Array<Extract<RunEvent, { type: 'artifact' }>>;
  /** The stream adapter can host a harness session (in-process step tools,
   *  sessions, skills) — the server SDK path sets it. A harness run without
   *  it fails at start rather than running some other way. */
  harnessSupported?: boolean;
  /** Effective harness strictness and where it came from, resolved by the
   *  server at run start (Run dialog > orchestration > Settings > strict). */
  harnessFollow?: ResolvedFollow;
  /** Whether a skill a harness step names is installed where the agent runs
   *  (server-side check; absent → not checked). */
  skillExists?: (name: string) => boolean;
  /** Working directory for a harness agent when the run has no single
   *  worktree (the server passes the workspace root). */
  harnessCwd?: string;
  /** The host's handle for driving a harness run from a terminal. */
  harnessControl?: HarnessControl;
}): AsyncIterable<RunEvent> {
  yield {
    type: 'run-start',
    orchestrationName: orchestration.name,
    // Stamp the definition's declared semver on the run record, so "which
    // version of this orchestration did run X execute" is answerable from
    // the event log without diffing snapshots.
    ...(typeof orchestration.version === 'string'
      ? { version: orchestration.version }
      : {}),
    ts: Date.now(),
  };
  if (worktrees && worktrees.length > 0) {
    yield {
      type: 'worktrees-ready',
      worktrees: worktrees.map(w => ({
        name: w.name,
        path: w.path,
        branch: w.branch,
        base: w.base,
        reused: w.reused === true,
      })),
      ts: Date.now(),
    };
  }

  // Lifecycle marker — emit a warning early when the orchestration is
  // deprecated or not yet promoted to prod, so the run viewer can flag
  // it. The run still proceeds; this is informational, not a refusal.
  if (orchestration.lifecycle?.deprecated) {
    yield {
      type: 'lifecycle-warning',
      deprecated: true,
      stage: orchestration.lifecycle.stage,
      reason:
        orchestration.lifecycle.deprecationReason ||
        'This orchestration is marked deprecated.',
      ts: Date.now(),
    };
  }

  let agents: AgentFile[];
  if (agentsOverride) {
    agents = agentsOverride;
  } else {
    try {
      agents = await listAgents();
    } catch (err) {
      yield {
        type: 'run-error',
        error: `Couldn't load agents: ${(err as Error).message}`,
        ts: Date.now(),
      };
      return;
    }
  }
  const agentByPath = new Map<string, AgentFile>(
    agents.map(a => [`agents/${a.name}.md`, a]),
  );

  // Preload all orchestrations for subflow lookup. Best-effort: a load failure
  // is non-fatal — only subflow nodes will fail at execution time. Name
  // collisions resolve by ORIGIN precedence (imported/domain > shipped
  // example), not readdir order — so a domain router deterministically shadows
  // a generic example of the same name (see setOrchestrationWithPrecedence).
  const orchestrationByName = new Map<string, Node>();
  if (orchestrationsOverride) {
    for (const o of orchestrationsOverride) {
      setOrchestrationWithPrecedence(orchestrationByName, o);
    }
  } else {
    try {
      const all = await listOrchestrations();
      for (const o of all) setOrchestrationWithPrecedence(orchestrationByName, o);
    } catch (err) {
      // Don't fail the run if listing is broken; subflows just won't resolve.
      console.warn('[executor] could not preload orchestrations:', err);
    }
  }
  // Ensure the root orchestration itself is in the map (e.g. an unsaved draft
  // that wouldn't show up in listOrchestrations). Lets a subflow ref to self
  // be properly cycle-detected rather than mysteriously not-found. Use the
  // precedence-aware insert so re-registering the root never DOWNGRADES a
  // higher-precedence entry already loaded under the same name (e.g. running a
  // shipped example by name when a domain orchestration of that name exists).
  setOrchestrationWithPrecedence(orchestrationByName, orchestration);

  const tools: Set<string> = configuredTools ?? new Set();
  const toolDecls: { nodeName: string; tools: string[] }[] = [];
  collectTools(orchestration, toolDecls);
  for (const decl of toolDecls) {
    // Only flag *connector* deps here (lowercase ids like 'github',
    // 'slack'). PascalCase names (Bash, Read, etc.) are Claude Code
    // built-in tools — they're not validated against the connector
    // registry, and runAgentPhase emits its own warning if the user
    // hasn't opted into agent tool execution. Without this filter we'd
    // pre-emit 12+ misleading "missing tools: Bash" warnings before
    // any phase actually starts.
    const connectorDeps = decl.tools.filter(t => !/^[A-Z]/.test(t));
    const missing = connectorDeps.filter(t => !tools.has(t));
    if (missing.length > 0) {
      yield {
        type: 'tools-warning',
        phaseName: decl.nodeName,
        missing,
        ts: Date.now(),
      };
    }
  }

  // Top-level `vars` get seeded into the initial state so descendant
  // prompts / system prompts / interpolated strings can reference
  // them as `${hostSim}` etc. without per-phase wiring.
  const seedVars: State = orchestration.vars ?? {};

  // Top-level `state` declarations: seed each slot with its `initial`
  // (or the reducer's natural identity — [] for append, {} for merge,
  // 0 for increment, undefined for replace/concat). These join
  // seedVars so interpolation sees an empty array/object until a
  // phase writes to the slot, instead of `${defectList}` rendering
  // as the literal placeholder.
  const stateDecls = orchestration.state ?? {};
  const seedReducers: State = {};
  for (const [key, decl] of Object.entries(stateDecls)) {
    if (decl.initial !== undefined) {
      seedReducers[key] = decl.initial;
    } else if (decl.reducer === 'append') {
      seedReducers[key] = [];
    } else if (decl.reducer === 'merge') {
      seedReducers[key] = {};
    } else if (decl.reducer === 'increment') {
      seedReducers[key] = 0;
    }
    // `replace` and `concat` get left undefined — first write sets them.
  }

  // Precompute the resolved sandbox policy per phase. Walk the tree
  // once, merging each node's `sandbox` with the inherited (ancestor)
  // policy — children may only tighten. runAgentPhase looks up its
  // phase here.
  const sandboxByPhase = new Map<string, Sandbox>();
  collectSandboxesInto(orchestration, undefined, sandboxByPhase);

  const ctx: ExecutorContext = {
    apiKey,
    model,
    streamFn: streamFn ?? streamAnthropic,
    agentByPath,
    waitForApproval,
    cancelled,
    halted: { v: false },
    lastOutput: initialInput ?? '',
    state: {
      input: initialInput ?? '',
      ...seedVars,
      ...seedReducers,
      ...(resolvedInputs ?? {}),
      ...(worktrees && worktrees.length > 0
        ? {
            worktrees: Object.fromEntries(
              worktrees.map(w => [w.name, { path: w.path, branch: w.branch, base: w.base, repo: w.repo }]),
            ),
          }
        : {}),
    },
    worktreeEnv: Object.fromEntries(
      (worktrees ?? []).map(w => [
        `SAMMY_WORKTREE_${w.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
        w.path,
      ]),
    ),
    defaultCwd: worktrees && worktrees.length === 1 ? worktrees[0].path : undefined,
    artifactBytes: { v: 0 },
    artifactsByName: new Map(),
    loadArtifact,
    scope: {},
    usage: { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
    budgets: [],
    configuredTools: tools,
    allowAgentTools: allowAgentTools === true,
    enforcesDeniedCommands: enforcesDeniedCommands === true,
    paused: paused ?? { v: false },
    chatQueue: chatQueue ?? new PhaseChatQueue(),
    orchestrationByName,
    // Run-wide limit fallbacks from the orchestration root (top-level only —
    // a `defaults` block on a child node is ignored). `?? {}` so resolution
    // is a no-op when none are declared, preserving the prior behavior.
    orchestrationDefaults: orchestration.defaults ?? {},
    // Unattended-mode switch from the orchestration root (top-level only).
    // `?? false` so a lock still pauses for human approval unless an
    // orchestration explicitly opts in — exactly the prior behavior.
    autoApproveAllLocks: orchestration.autoApproveLocks ?? false,
    subflowStack: [orchestration.name],
    replayOutputs: new Map(Object.entries(replayOutputs ?? {})),
    replayScope: '',
    autoApproveLocks: new Set(autoApproveLocks ?? []),
    gateMessages: new Map(Object.entries(gateMessages ?? {})),
    // Durable-wait seams (see ExecutorContext docs): pendingWaits carries a
    // prior leg's unresolved wait specs on resume, deliveredSignals the
    // buffered signal payloads; durableWaits flips a parked wait from an
    // in-process sleep to a snapshot+pause (server-owned runs).
    pendingWaits: new Map(Object.entries(pendingWaits ?? {})),
    deliveredSignals: new Map(
      Object.entries(deliveredSignals ?? {}).map(
        ([k, v]) => [k, [...v]] as [string, string[]],
      ),
    ),
    durableWaits: durableWaits === true,
    sandboxByPhase,
    providerStreamFns: providerStreamFns ?? {},
    credentialsByName: credentialsByName ?? {},
    credentialsRaw: credentialsRaw ?? {},
    injectedSecrets: injectedSecrets ?? new Set<string>(),
    stateDecls,
    runId,
    orchestrationName: orchestration.name,
    asProducers: collectAsNames(orchestration),
  };

  // A fork's replayed leaves' artifacts: part of this run's record, and
  // uploadable by a later `http.files` step.
  for (const a of seedArtifacts ?? []) {
    ctx.artifactsByName.set(a.name, {
      text: a.content,
      mediaType: a.mediaType,
      ...(a.dropped ? { dropped: true } : {}),
    });
    ctx.artifactBytes.v += a.content.length;
    yield { ...a, ts: Date.now() };
  }

  // Preflight: fast-fail a config miss instead of erroring ~30s deep in a
  // phase on every fire. If the tree uses the `code.run` escape hatch but
  // SAMMY_ALLOW_CODE_RUN is off, the run is doomed — the runtime guard
  // (runCodePhase) would reject the first code node it reaches. Refuse here,
  // at run start, with one clear, actionable message naming the flag. (The
  // runtime guard stays as defense-in-depth for nodes reachable only via a
  // subflow, whose body this static walk can't see.) Reuses codeRunEnabled()
  // so this check and the deep guard read the flag identically.
  if (orchestrationUsesCodeRun(orchestration) && !codeRunEnabled()) {
    yield {
      type: 'run-error',
      error:
        'Run halted at preflight: this orchestration uses code.run (arbitrary ' +
        'shell execution) but neither SAMMY_ALLOW_CODE_RUN nor ' +
        'SAMMY_CODE_RUN_ALLOW is set. Set SAMMY_ALLOW_CODE_RUN=1 to enable it, ' +
        'SAMMY_CODE_RUN_ALLOW to allow specific commands, or replace the ' +
        'code.run node with an agent using the Bash tool (which the sandbox ' +
        'policy governs).',
      ts: Date.now(),
    };
    return;
  }

  // Preflight: fast-fail a credential miss instead of failing DEEP when the
  // node dispatches (env injection at runAgentPhase silently filters a missing
  // credential to {}, so the agent runs without the secret and the external
  // service dies confusingly downstream). A node declaring `credential` /
  // `credentials[]` that names an entry not in this run's resolved registry is
  // doomed — refuse here, naming every missing credential AND its owning node.
  //
  // FALSE-POSITIVE GUARD: only enforce when the run was actually GIVEN a
  // credential registry. The server-owned run path passes credentialsByName +
  // credentialsRaw (possibly empty); anonymous / CLI / in-browser runs pass
  // NEITHER (the destructured params are `undefined`, not `{}` — the `?? {}`
  // that fills ctx happens after this check). When neither map was supplied we
  // can't tell "configured with nothing" from "credentials resolved elsewhere",
  // so we no-op rather than risk a wrong error. A credential is considered
  // AVAILABLE if it's present in EITHER map (provider-routing reads
  // credentialsByName; env-injection reads credentialsRaw — a run may populate
  // only the one it needs). The dispatch-time resolution stays as a backstop.
  if (credentialsByName !== undefined || credentialsRaw !== undefined) {
    const available = new Set<string>([
      ...Object.keys(credentialsByName ?? {}),
      ...Object.keys(credentialsRaw ?? {}),
    ]);
    const missing: { node: string; credential: string }[] = [];
    const seen = new Set<string>();
    for (const ref of collectCredentialRefs(orchestration)) {
      if (available.has(ref.credential)) continue;
      // NUL delimiter (it cannot appear in a node or credential name, so
      // the pair cannot be forged by a name containing the separator) —
      // written as the ESCAPE, never as a literal 0x00 byte. A raw NUL here
      // made this entire 5,200-line file classify as *binary* to grep,
      // ripgrep, `git diff` and GitHub's diff viewer, so a search for any
      // symbol in the repo's most important file silently returned nothing
      // unless the reader knew to pass `-a`. Same character at runtime.
      const key = `${ref.node}\u0000${ref.credential}`;
      if (seen.has(key)) continue;
      seen.add(key);
      missing.push(ref);
    }
    if (missing.length > 0) {
      const detail = missing
        .map(
          m =>
            `node "${m.node}" declares credential "${m.credential}", which is not configured for this run`,
        )
        .join('; ');
      yield {
        type: 'run-error',
        error:
          `Run halted at preflight: ${detail}. Add it to credentials.json / ` +
          `the workspace credentials, or remove the reference.`,
        ts: Date.now(),
      };
      return;
    }
  }

  if (orchestration.execution !== 'harness') {
    const skillOnly = skillOnlySteps(orchestration);
    if (skillOnly.length > 0) {
      yield {
        type: 'run-error',
        error:
          `Run halted at preflight: ${skillOnly.map(n => `"${n}"`).join(', ')} only name a skill, which ` +
          'only a harness can run. Run it as a harness, or give those steps an agent.',
        ts: Date.now(),
      };
      return;
    }
  }

  try {
    if (orchestration.execution === 'harness') {
      yield* runHarness(orchestration, ctx, {
        supported: harnessSupported === true,
        ...(harnessFollow ? { follow: harnessFollow } : {}),
        ...(skillExists ? { skillExists } : {}),
        ...(harnessCwd ? { cwd: harnessCwd } : {}),
        ...(harnessControl ? { control: harnessControl } : {}),
      });
      yield { type: 'run-end', ts: Date.now() };
      return;
    }
    // The root `phases` are a sequence like any nested `phases` composite, so
    // they honor `finally` the same way: run the regular (non-`finally`) phases
    // first, then run every `finally` phase AFTER — even if a regular phase
    // threw / timed out (the sequence is unwinding). This is what lets a long
    // root-level QA sweep aggregate + file its findings in a finalizer even
    // when one leg timed out, instead of the whole run dying with nothing.
    const allPhases = orchestration.phases ?? [];
    const regularRoot = allPhases.filter(p => p.finally !== true);
    const finalizerRoot = allPhases.filter(p => p.finally === true);
    // The error that unwound the regular sequence (if any); re-thrown AFTER the
    // finalizers so a finalizer can't mask the real failure.
    let rootUnwindError: Error | null = null;
    for (const phase of regularRoot) {
      try {
        yield* executeNode(phase, ctx, ctx.lastOutput);
      } catch (err) {
        // continueOnError honored at the root level too — was only
        // honored inside nested `phases` composites + map bodies
        // before, which meant the same orchestration JSON behaved
        // differently depending on whether it was wrapped or not.
        // Cancellation / pause / budget always bubble — those are
        // user- or policy-initiated, not real failures the run
        // should shrug off (they also skip finalizers).
        if (err instanceof RunCancelled) throw err;
        if (err instanceof RunPauseRequested) throw err;
        if (err instanceof BudgetExceededError) throw err;
        if (phase.continueOnError) {
          yield {
            type: 'phase-error',
            phaseName: phase.name,
            error: (err as Error).message,
            ts: Date.now(),
          };
          // Don't advance ctx.lastOutput — the failed phase produced
          // nothing for the next phase to consume. Next iteration of
          // the loop picks up with whatever the previous successful
          // phase left in lastOutput.
        } else {
          // Non-recoverable: stop the regular sequence, run finalizers, then
          // re-throw this original error below.
          rootUnwindError = err as Error;
          break;
        }
      }
      // A phase with `halt` (or one deeper that tripped the flag) ends the
      // run — stop walking the remaining top-level phases (finalizers still run).
      if (ctx.halted.v) break;
    }

    // Root-level finalizer phases — best-effort, always run. Each honors its
    // own timeout (it goes through executeNode); a finalizer's own failure is
    // surfaced as a phase-error but NEVER masks the original error that unwound
    // the sequence. Cancel / pause / budget from a finalizer bubble.
    let rootFinalizerError: Error | null = null;
    for (const fin of finalizerRoot) {
      try {
        yield* executeNode(fin, ctx, ctx.lastOutput);
      } catch (err) {
        if (err instanceof RunCancelled) throw err;
        if (err instanceof RunPauseRequested) throw err;
        if (err instanceof BudgetExceededError) throw err;
        yield {
          type: 'phase-error',
          phaseName: fin.name,
          error: (err as Error).message,
          ts: Date.now(),
        };
        if (!fin.continueOnError && rootFinalizerError === null) {
          rootFinalizerError = err as Error;
        }
      }
    }

    // The original error always wins; a finalizer error only surfaces when the
    // regular sequence succeeded.
    if (rootUnwindError) throw rootUnwindError;
    if (rootFinalizerError) throw rootFinalizerError;
  } catch (err) {
    if (err instanceof RunCancelled) {
      yield { type: 'run-cancelled', ts: Date.now() };
      return;
    }
    if (err instanceof RunPauseRequested) {
      // Propagate via throw — the run-controller catches it, writes
      // status='paused' + the pausedFor phase, and exits cleanly. The
      // executor itself does NOT emit run-end here; the controller
      // emits the pause sentinel and updates the row.
      throw err;
    }
    yield { type: 'run-error', error: (err as Error).message, ts: Date.now() };
    return;
  }

  yield { type: 'run-end', ts: Date.now() };
}
