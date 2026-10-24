/**
 * RunStore — the durable run-persistence interface.
 *
 * sammy-pack ships two backends behind this one async interface:
 *
 *   - SqliteRunStore  (default) — a single `runs.db` file. Zero infra:
 *     `npm run dev` and runs are durable. The pilot / local-dev path.
 *   - PostgresRunStore (opt-in)  — activated when `DATABASE_URL` is set.
 *     The enterprise / shared-deployment path.
 *
 * The layering is the point: one pluggable store — SQLite for the dev
 * server, PostgreSQL for production — with the engine above never
 * knowing which is underneath. Selecting a backend is a deployment
 * decision (an env var), not a code change.
 *
 * The interface is async because the Postgres driver (`pg`) is async.
 * The SQLite backend wraps its synchronous `better-sqlite3` calls to
 * satisfy the same contract.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { foldSpend } from '../lib/spend';
import type { DegradationReason } from './degradation';
// Value import is safe: wait-resolution imports only TYPES from this
// module, so there is no runtime cycle.
import { pendingWaitOf } from './wait-resolution';

export type RunStatus =
  | 'running'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'paused'
  | 'interrupted';

const VALID_STATUSES = new Set<RunStatus>([
  'running',
  'done',
  'error',
  'cancelled',
  'paused',
  'interrupted',
]);

/** Guard a status write. The SQLite CHECK constraint was dropped (it
 *  needed a table rebuild to evolve) — this is the runtime equivalent,
 *  shared by both backends. */
export function assertStatus(s: string): asserts s is RunStatus {
  if (!VALID_STATUSES.has(s as RunStatus)) {
    throw new Error(`Invalid run status: ${s}`);
  }
}

/**
 * Run-lease TTL. While a process is executing a run it stamps the run with its
 * `lease_owner` + a `lease_expires_at = now + this`, refreshed on every
 * `appendEvent` (the heartbeat). Boot's orphan scan only reclaims a `running`
 * run whose lease has *expired* — so a run a live peer/worker is actively
 * executing (its lease keeps moving forward) is never stolen.
 *
 * Sized to comfortably exceed the longest expected gap between events — a
 * non-streaming provider (e.g. Bedrock Converse) can sit silent for the whole
 * model call between `phase-start` and `phase-end`. The cost of a generous TTL
 * is only that a *genuinely* crashed run is reclaimed up to this long after the
 * crash (the boot-time delayed re-scan picks it up), which is the safe
 * direction to err.
 */
export const DEFAULT_LEASE_TTL_MS = 120_000;

/** Per-process lease identity for a store. Defaults: a fresh random
 *  `instanceId` per process, `DEFAULT_LEASE_TTL_MS`. */
export type RunStoreLeaseOpts = {
  instanceId?: string;
  leaseTtlMs?: number;
};

/**
 * Thrown by `appendEvent` when this process no longer owns a run's lease — a
 * peer reclaimed it (this process stalled past the TTL) and is now the single
 * writer. The fencing token: a non-owner's write is rejected, not silently
 * accepted, so the two processes can't both append to one run. The
 * run-controller catches this and yields the run WITHOUT touching its rows.
 */
export class LeaseLostError extends Error {
  constructor(
    readonly runId: string,
    readonly heldBy: string,
    readonly ownedBy: string | null,
  ) {
    super(
      `lease for run "${runId}" is held by ${ownedBy ?? '(none)'}, not this ` +
        `process (${heldBy}) — yielding`,
    );
    this.name = 'LeaseLostError';
  }
}

/** A persisted event — opaque to the store. Whatever the executor
 *  emits (see RunEvent in app/src/llm/executor.ts); the store just
 *  persists + replays it. */
export type StoredEvent = Record<string, unknown> & {
  type: string;
  ts?: number;
};

/** The durable `run-interrupted` event a reclaim appends. Shared by both
 *  backends so the explanation cannot drift between them.
 *
 *  The text used to say "Server process restarted with this run still in
 *  flight. Marked interrupted on boot." — true while the scan was boot-only,
 *  false once it became a periodic sweep that also runs on a long-lived
 *  process. It now states the actual cause (the lease lapsed at a time, under
 *  an owner) and who reclaimed it, with the same facts as structured fields
 *  for anything that reads the log programmatically. */
export function interruptedEvent(
  previousOwner: string | null,
  leaseExpiredAt: number | null,
  reclaimedBy: string,
  now: number,
): StoredEvent {
  const expiry =
    leaseExpiredAt == null
      ? 'the run was never leased'
      : `its lease expired at ${new Date(leaseExpiredAt).toISOString()}`;
  return {
    type: 'run-interrupted',
    ts: now,
    reason:
      `Run was still in flight but ${expiry} (last owner: ` +
      `${previousOwner ?? 'none'}) — its process is presumed gone (crashed, ` +
      `restarted, or stalled past the lease). Reclaimed by ${reclaimedBy} and ` +
      'marked interrupted; resumable from its checkpoint.',
    leaseExpiredAt,
    previousOwner,
    reclaimedBy,
  };
}

/** Derive the run's "most recent output" from its event stream — the last
 *  phase-end's `output`, else the last error text. Stores denormalize this
 *  into the `last_output` column on upsert so the LIST endpoint can ship a
 *  short preview snippet WITHOUT loading every run's events (the OOM fix).
 *  Returns null when there's nothing substantive to show. */
export function derivePreviewFromEvents(
  events: ReadonlyArray<StoredEvent>,
): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as {
      type: string;
      output?: unknown;
      error?: unknown;
    };
    if (e.type === 'phase-end' && typeof e.output === 'string' && e.output.trim()) {
      return e.output;
    }
    if (
      (e.type === 'run-error' || e.type === 'phase-error') &&
      typeof e.error === 'string' &&
      e.error.trim()
    ) {
      return e.error;
    }
  }
  return null;
}

/** Sum the run's spend-to-date from its event stream — every `phase-end`
 *  carries the USD cost of that single leaf call (`costUsd`, 0 when the model
 *  price is unknown), and a leaf's own `phase-error` carries what its FAILED
 *  attempt spent (a failed attempt never reaches a phase-end, and `retry`
 *  then pays again — folding phase-ends alone hid a retry storm from every
 *  cap). Never the cumulative `cost` event. A pure O(events) fold, shared by
 *  the run-detail API and {@link summarizeRun} so "live cost" is derived the
 *  same way everywhere and can't drift from the events. Non-finite / missing
 *  costs are treated as 0. */
export function sumCostUsd(events: ReadonlyArray<StoredEvent>): number {
  // `lib/spend` is the one answer to "which events count" — the caps, both
  // digests and the run card read it. A second copy of the rule here is how
  // the surfaces drifted apart in the first place.
  return foldSpend(events).costUsd;
}

export type RunHeader = {
  id: string;
  orchestrationName: string;
  startedAt: number;
  endedAt: number | null;
  status: RunStatus;
  orchestrationSnapshot: unknown | null;
  initialInput: string | null;
  currentPath: unknown | null;
  stateJson: unknown | null;
  lastOutput: string | null;
  pausedFor: string | null;
  /** Leaf phases whose outputs are captured in stateJson — resume reads
   *  this to skip-replay already-completed leaves. */
  completedLeaves: string[] | null;
  updatedAt: number;
  /** Owner identity — multi-tenancy seam. Defaults to 'system' when
   *  no `X-Sammy-User` header is supplied (single-tenant default). */
  ownerId: string;
  /** Concurrency-group this run belongs to (the orchestration root's
   *  `concurrency.group`), or null when the orchestration declares none. The
   *  start-gate refuses to overlap two active runs sharing a group; the
   *  terminal drain reads it to release a parked fire. Opaque to the store. */
  concurrencyGroup: string | null;
  /** "done-but-degraded" signal. A run can reach a non-error terminal status
   *  (`done`) while having swallowed a phase error, finalized a fan-out with
   *  partials, taken a documented fallback, or had a node stall-aborted and
   *  carried on — `status` alone masks that. `degraded` makes it a first-class,
   *  queryable property; `degradationReasons` is the per-phase explanation.
   *  Computed from the durable event stream at terminal time (see
   *  degradation.ts). Defaults to false / [] (a clean run, and every
   *  non-terminal / pre-degradation row). */
  degraded: boolean;
  degradationReasons: DegradationReason[];
};

export type Run = RunHeader & {
  events: StoredEvent[];
  eventVersion: number;
};

/**
 * A LIGHTWEIGHT run status snapshot — header fields plus a few counts
 * derived from the event stream, but WITHOUT the (potentially multi-MB)
 * events array. This is what a monitor/poller wants: enough to render a
 * status line and detect progress, none of the weight of the full run.
 * The full event stream is still available via `getRun`.
 */
export type RunSummary = {
  id: string;
  orchestrationName: string;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  /** Count of `phase-start` events. */
  phasesStarted: number;
  /** Count of `phase-end` events. */
  phasesEnded: number;
  /** Count of `phase-tool-use` events (tool invocations by leaf agents). */
  toolUses: number;
  /** `type` of the most recent event, or null when the run has no events. */
  lastEventType: string | null;
  /** `ts` of the most recent event, or null when absent/unknown. */
  lastEventTs: number | null;
  /** The run's LIVENESS clock, epoch ms: the newest event of ANY type —
   *  which, now that phase-heartbeat events flow (≤ ~1/30s while an SDK
   *  turn works silently), tracks the stall watchdog's own progress clock
   *  to within one beat. Poll THIS to detect true silence without parsing
   *  events; a `running` run whose lastProgressAt is minutes old is
   *  genuinely wedged, not quietly working — the false-silence gap this
   *  clock exists to close. Same value as lastEventTs — named + documented
   *  as the stable liveness contract. */
  lastProgressAt: number | null;
  /** The phase the run is CURRENTLY in — the last `phase-start`'s name while
   *  the run is live (running / paused); null on a terminal run or before any
   *  phase started. Lets a poller render "run X is on phase Y" without the full
   *  event stream. */
  currentPhase: string | null;
  /** Spend-to-date in USD, summed from every `phase-end.costUsd` plus each
   *  failed attempt's `phase-error.costUsd` (0 when model prices are unknown).
   *  The mid-flight "how much has this burned" number a budget-bounded run
   *  wants — previously the API returned only `null`. */
  costUsd: number;
  /** "done-but-degraded" signal — true when a `done` run swallowed an error /
   *  finalized partials / took a fallback (see the run header's `degraded`). A
   *  poller wants this in the lightweight snapshot so it can flag a degraded
   *  success without fetching the full event stream. */
  degraded: boolean;
  /** Per-phase degradation reasons; empty for a clean run. */
  degradationReasons: DegradationReason[];
};

/** Derive a {@link RunSummary} from a header + its events. Shared by every
 *  backend so the lightweight shape (and the count semantics) stay identical
 *  no matter where the run is stored. Scans the events once for the phase /
 *  tool-use tallies and the last-event fields; never returns the events. */
export function summarizeRun(
  header: RunHeader,
  events: ReadonlyArray<StoredEvent>,
): RunSummary {
  let phasesStarted = 0;
  let phasesEnded = 0;
  let toolUses = 0;
  let lastPhaseStart: string | null = null;
  for (const e of events) {
    if (e.type === 'phase-start') {
      phasesStarted += 1;
      const p = (e as { phaseName?: unknown }).phaseName;
      if (typeof p === 'string') lastPhaseStart = p;
    } else if (e.type === 'phase-end') phasesEnded += 1;
    else if (e.type === 'phase-tool-use') toolUses += 1;
  }
  const last = events.length > 0 ? events[events.length - 1] : null;
  // A run is "live" (still on a phase) only while running/paused; a terminal
  // run has no current phase even though its last phase-start is still in the
  // stream.
  const isLive = header.status === 'running' || header.status === 'paused';
  return {
    id: header.id,
    orchestrationName: header.orchestrationName,
    status: header.status,
    startedAt: header.startedAt,
    endedAt: header.endedAt,
    phasesStarted,
    phasesEnded,
    toolUses,
    lastEventType: last ? last.type : null,
    lastEventTs:
      last && typeof last.ts === 'number' && Number.isFinite(last.ts)
        ? last.ts
        : null,
    lastProgressAt:
      last && typeof last.ts === 'number' && Number.isFinite(last.ts)
        ? last.ts
        : null,
    currentPhase: isLive ? lastPhaseStart : null,
    costUsd: sumCostUsd(events),
    degraded: header.degraded,
    degradationReasons: header.degradationReasons,
  };
}

/** Input to a full-run upsert (legacy POST /api/runs path). */
export type UpsertRunInput = {
  id: string;
  orchestrationName: string;
  startedAt: number;
  endedAt?: number | null;
  status: RunStatus;
  events: StoredEvent[];
  orchestrationSnapshot?: unknown;
  initialInput?: string | null;
  /** Owner; defaults to 'system' for single-tenant deployments. */
  ownerId?: string;
  /** Concurrency-group for this run (the orchestration root's
   *  `concurrency.group`). Null/omitted when the orchestration declares none. */
  concurrencyGroup?: string | null;
};

/** Header / checkpoint columns a run-controller write may touch. */
export type UpdateRunPatch = Partial<{
  status: RunStatus;
  endedAt: number | null;
  currentPath: unknown;
  stateJson: unknown;
  lastOutput: string | null;
  pausedFor: string | null;
  completedLeaves: string[];
  /** "done-but-degraded" verdict, written by the run-controller at a `done`
   *  terminal. `degradationReasons` is stored as JSON; an empty array clears
   *  any prior degradation (e.g. on resume the run may end clean). */
  degraded: boolean;
  degradationReasons: DegradationReason[];
}>;

// ── Trigger deliveries (P0: durable, idempotent ingress) ──────────────────
//
// Every trigger fire — HTTP (webhook/events/deployment/queue) or timer
// (cron/polling) — is persisted here BEFORE the run is created, and
// deduplicated by an idempotency key. This is the durable seam the worker
// queue (P1) drains.

export type DeliveryStatus =
  | 'accepted' // recorded; not yet enqueued (legacy / P0 default)
  | 'pending' // enqueued, waiting for a worker to claim it
  | 'claimed' // a worker is firing this delivery's run right now
  | 'fired' // run created (success terminal)
  | 'duplicate' // collapsed onto a prior delivery by idempotency key
  | 'rejected' // refused by policy (budget cap, orchestration missing)
  | 'deferred' // durably PARKED behind a busy concurrency group; will run
  | 'failed'; // worker tried and exhausted retries (dead-letter)

const VALID_DELIVERY_STATUSES = new Set<DeliveryStatus>([
  'accepted',
  'pending',
  'claimed',
  'fired',
  'duplicate',
  'rejected',
  'deferred',
  'failed',
]);

export function assertDeliveryStatus(s: string): asserts s is DeliveryStatus {
  if (!VALID_DELIVERY_STATUSES.has(s as DeliveryStatus)) {
    throw new Error(`Invalid delivery status: ${s}`);
  }
}

export type DeliveryRecord = {
  id: string;
  kind: string;
  name: string;
  orchestrationName: string;
  idempotencyKey: string;
  keySource: 'header' | 'auto' | 'window';
  status: DeliveryStatus;
  runId: string | null;
  body: string | null;
  detail: string | null;
  ownerId: string;
  receivedAt: number;
  firedAt: number | null;
  /** How many times a worker has claimed this delivery (queue/P1). This is
   *  the RETRY BUDGET, and `replayDelivery` resets it to 0 — so it must not
   *  be used as a claim fence. Use `claimToken`. */
  attempts: number;
  /** How many additional fires have been SUPPRESSED onto this row by the
   *  idempotency key. 0 means this fire arrived once. */
  duplicateCount: number;
  /** Monotonic claim counter, bumped on every claim and NEVER reset. The
   *  fence a worker must present to settle a delivery: a worker that stalled
   *  past the reclaim window holds a stale token, so its terminal write
   *  matches no row instead of overwriting the result of whichever worker
   *  re-claimed and ran it. */
  claimToken: number;
  /** Earliest time a worker may claim it — drives retry backoff (P1/P2). */
  availableAt: number;
  /** When a worker claimed it; null when not in flight. */
  claimedAt: number | null;
  /** Last failure reason (queue/P2). */
  lastError: string | null;
  /** Event-chain depth for reactive eventing loop-guarding (P3). */
  chainDepth: number;
};

export type DeliveryInput = {
  id: string;
  kind: string;
  name: string;
  orchestrationName: string;
  idempotencyKey: string;
  keySource: 'header' | 'auto' | 'window';
  /** Defaults to 'accepted'. */
  status?: DeliveryStatus;
  runId?: string | null;
  body?: string | null;
  detail?: string | null;
  /** Defaults to 'system'. */
  ownerId?: string;
  receivedAt: number;
  /** Defaults to `receivedAt`. */
  availableAt?: number;
  /** Defaults to 0. */
  chainDepth?: number;
};

export type DeliveryPatch = Partial<{
  status: DeliveryStatus;
  runId: string | null;
  detail: string | null;
  firedAt: number | null;
}>;

// ── Trigger-fire outcomes (cron circuit-breaker) ──────────────────────────
//
// A scheduled (cron) orchestration that fails on EVERY fire silently accrues
// a graveyard of failed runs — nothing escalates, so 20+ consecutive errors
// over days go unnoticed. This is the durable seam the API uses to detect
// that: each terminal run of a trigger appends its outcome here, keyed by a
// STABLE trigger key (orchestration + cron expr), and the API reads the
// trailing run of consecutive failures to decide whether to alert / pause.
//
// One row per terminal fire. Newest-first, a `done` resets the streak — so
// the breaker only escalates on a run of failures with NO success in between.

/** One terminal trigger-fire outcome row. `status` is the run's final
 *  {@link RunStatus} ('done' counts as success; anything else is a failure
 *  for streak purposes). `triggerKey` is the stable identity of the trigger
 *  (e.g. `cron:<orch>:<expr>`), NOT the run id. */
export type TriggerFireRecord = {
  triggerKey: string;
  runId: string;
  status: string;
  ts: number;
};

/**
 * Count the trailing run of CONSECUTIVE non-`done` outcomes for a trigger,
 * given its fire rows ordered newest-first. Stops at the first `done` (a
 * success resets the streak). Pure + backend-agnostic so both stores share
 * one definition of "consecutive failures".
 */
/** Statuses that are NOT a verdict on the orchestration, so they neither
 *  count as a failure nor reset the streak — they are simply skipped:
 *
 *    running     — still going.
 *    paused      — parked at a `lock` gate waiting for a HUMAN. Counting
 *                  this was the bug: a nightly cron whose orchestration has
 *                  an approval gate accrued one "failure" per night and
 *                  tripped the breaker after three, disabling the schedule
 *                  (with SAMMY_CRON_AUTO_PAUSE=1) although nothing had
 *                  failed and the operator had merely not clicked approve.
 *    interrupted — the SERVER restarted mid-run. That is our fault, not the
 *                  orchestration's, and three deploys would otherwise trip
 *                  the breaker.
 *
 *  A genuine failure is `error` or `cancelled`. `done` ends the streak. */
const NON_VERDICT_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'paused',
  'interrupted',
]);

export function countConsecutiveFailuresNewestFirst(
  rows: ReadonlyArray<{ status: string }>,
): number {
  let n = 0;
  for (const r of rows) {
    if (r.status === 'done') break;
    if (NON_VERDICT_STATUSES.has(r.status)) continue;
    n += 1;
  }
  return n;
}

// ── Concurrency groups (mutual exclusion for shared-resource runs) ─────────
//
// An orchestration whose root declares `concurrency: { group, policy }` must
// not run concurrently with any other run in the same OPAQUE group. When a
// fire conflicts with an active run in its group under the `queue` policy, the
// fire is PARKED here instead of started; the conflicting run's terminal drain
// dequeues + starts the oldest parked fire (FIFO). The group string is opaque
// to the store — it never interprets what the resource is.

/** A parked trigger fire awaiting its concurrency group to free up. Carries
 *  exactly what the start path needs to fire the run later. The store assigns
 *  the FIFO ordering (oldest row first); callers see only the payload. */
export type PendingFire = {
  orchName: string;
  initialInput: string | null;
  ownerId: string;
  /** The fire's resolved declared inputs (`${ticket}` …), so the run that is
   *  drained off the queue later still has them. */
  resolvedInputs?: Record<string, string> | null;
};

/** A parked fire WITH its store bookkeeping — what the queue-visibility
 *  endpoint (GET /api/concurrency) renders. The plain {@link PendingFire}
 *  stays the dequeue/start payload; this read-only shape adds the identity
 *  and age an operator needs to see "what's stuck behind what". */
export type PendingFireRecord = PendingFire & {
  /** Store-assigned FIFO id (monotonic insertion order — the dequeue order). */
  id: number;
  /** The concurrency group the fire is parked behind. */
  group: string;
  /** Epoch ms when the fire was parked (queue age = now - queuedAt). */
  queuedAt: number;
};

export interface RunStore {
  /** Which backend this is — for boot logs. */
  readonly backend: 'sqlite' | 'postgres';

  /** Absolute path of the backing database file when the backend is
   *  file-based (SQLite). Undefined for server-backed stores (Postgres).
   *  Lets the boot banner report the file + its size, and the retention
   *  sweep report bytes actually reclaimed. */
  readonly filePath?: string;

  /** Run headers without events — for the sidebar / Runs page. When
   *  `ownerId` is provided, results are scoped to that owner (the
   *  multi-tenancy seam); omit to list across owners. */
  listRuns(limit?: number, ownerId?: string): Promise<RunHeader[]>;

  /** EVERY paused run's header, unbounded — the sweepers' view (stale
   *  gates, due waits). listRuns's newest-N window can hide an old paused
   *  run on a busy store; a sweeper that misses one strands it (a wait
   *  never resumes, an abandoned gate holds its group forever). Paused
   *  runs are inherently few, so this stays a small scan. */
  listPausedRuns(): Promise<RunHeader[]>;

  /**
   * Full run including its event stream, ordered by seq.
   *
   * `ownerId` is the AUTHORIZATION scope, not a filter convenience. When
   * provided, a run belonging to a different owner reads as **null** — the
   * same answer as a run that does not exist, deliberately, so a caller
   * cannot use the response to probe which ids are real.
   *
   * It is optional because the engine's own callers (sweepers, the delivery
   * worker, the run controller, retention) legitimately operate across
   * owners. Every REQUEST-handling caller must pass it. Taking the scope in
   * the store rather than comparing `run.ownerId` at each route is the point:
   * there were eleven per-id routes and not one of them compared anything,
   * because the interface gave them nowhere to put the check.
   */
  getRun(id: string, ownerId?: string): Promise<Run | null>;

  /** A LIGHTWEIGHT status snapshot — header + event-derived counts, WITHOUT
   *  the events array. What a monitor/poller wants; spares it the multi-MB
   *  `getRun` payload on a big run. Null when the run is missing — or when
   *  `ownerId` is given and the run belongs to someone else (see `getRun`). */
  getRunSummary(id: string, ownerId?: string): Promise<RunSummary | null>;

  /** Event count per run id, in ONE aggregate query — the cheap input the
   *  list endpoint needs for each run's `eventVersion` without loading any
   *  event bodies. Ids not present (zero events) are simply absent from the
   *  returned map. Pass the headers' ids; an empty input returns an empty
   *  map. */
  eventCounts(runIds: string[]): Promise<Map<string, number>>;

  /** Upsert a complete run record (events replaced wholesale). */
  upsertRun(run: UpsertRunInput): Promise<void>;

  /** Append one event to a run's stream. The live-write path. */
  appendEvent(runId: string, event: StoredEvent): Promise<void>;

  /** Delete a run and cascade-remove its events. Returns false when the run
   *  is absent — or when `ownerId` is given and the run belongs to another
   *  owner, which must be indistinguishable from absent (see `getRun`). */
  deleteRun(id: string, ownerId?: string): Promise<boolean>;

  /** Patch a run's header / checkpoint columns. Returns true when a row was
   *  written.
   *
   *  UNFENCED by default, deliberately: an admin cancel from ANOTHER process
   *  flips a running row it does not own (the cross-process cancel path), and
   *  a reclaim-then-resume claims a lease it does not yet hold.
   *
   *  `requireLease` fences the write on the same predicate `renewLease` uses
   *  — this process is `lease_owner` AND the row is still `running`. Zero
   *  rows then throws `LeaseLostError`, exactly like a fenced `appendEvent`.
   *  The run-controller passes it for its per-leaf checkpoint and for the
   *  terminal it writes on the executor's behalf: both are WHOLESALE
   *  overwrites of `completed_leaves` / `state_json` / `status`, i.e. the
   *  state the new owner resumes from. `appendEvent` was fenced and these
   *  were not, so a process that stalled past the TTL, was reclaimed, and
   *  then woke up could stamp its stale checkpoint — or a `cancelled` —
   *  over the peer's live progress.
   *
   *  `onlyIfStatus` puts a status precondition IN the UPDATE. `resume()`
   *  uses it to flip `→ running` only from a resumable state, so two
   *  concurrent resumes cannot both pass a read-then-write guard and both
   *  start an executor for one run; the loser sees `false`. A miss here
   *  returns false rather than throwing — it is a lost race, not a lost
   *  lease. */
  updateRunStatus(
    id: string,
    patch: UpdateRunPatch,
    opts?: { requireLease?: boolean; onlyIfStatus?: RunStatus[] },
  ): Promise<boolean>;

  /** Boot + periodic housekeeping — flag still-`running` rows whose lease has
   *  expired as `interrupted` (their owning process died) and append a
   *  run-interrupted event. A run a live peer is actively executing keeps its
   *  lease fresh and is left alone. `now` defaults to the wall clock
   *  (overridable for tests).
   *
   *  A store NEVER reclaims a run whose `lease_owner` is its OWN instance.
   *  While the scan was boot-only that could not happen (a fresh process has
   *  a fresh id); once it became a periodic sweep, a process whose event loop
   *  was blocked past the TTL — a long synchronous prune, a laptop lid —
   *  would reclaim its own live run, and the renew that followed would then
   *  report the lease lost and abort the work. The owner's next renew pushes
   *  the lease forward instead; only a PEER may take an expired-lease run.
   *
   *  That exclusion protects a LIVE own run. `isLocallyActive` lets the
   *  caller say which of its rows it still drives: an own row it has let go
   *  of — a leg whose terminal write failed every retry and tore itself down,
   *  heartbeat stopped — is reclaimed like a dead peer's once its lease
   *  lapses. Without it the single-process deployment, which has no peer,
   *  held that row (and its concurrency group) until a restart. */
  markOrphanedRunsAsInterrupted(
    now?: number,
    opts?: { isLocallyActive?: (id: string) => boolean },
  ): Promise<{ count: number; ids: string[] }>;

  /** Push this run's lease forward (now + TTL) IF this process still owns it
   *  and the run is still `running`. The interval-heartbeat that keeps a lease
   *  fresh through a phase that emits no events (e.g. a long non-streaming
   *  model call) — without it, only `appendEvent` renews, so a silent phase
   *  past the TTL could be reclaimed mid-flight. Returns true if it renewed
   *  (still the owner), false if the lease was lost / the run ended. */
  renewLease(id: string): Promise<boolean>;

  /** Sum LLM cost (USD) from phase-end events plus failed attempts'
   *  phase-error events, bucketed into today / this-calendar-month by each
   *  run's start time. Drives the budget gate. */
  /**
   * Spend to date, today and month.
   *
   * `ownerId` scopes it to one owner. Without that scope the budget cap is
   * workspace-GLOBAL, which on a shared deployment is a self-inflicted DoS:
   * one team's runaway sweep refuses every other team's runs, with an HTTP
   * 402 and a log line as the only signal. Omit it for the global figure
   * (the boot banner, the workspace status surface).
   */
  costSummary(ownerId?: string): Promise<{ todayUsd: number; monthUsd: number }>;

  /** One orchestration's usage since `dayStart` / `monthStart` (epoch ms):
   *  runs started today and spend today / this month. Feeds the root
   *  `limits` admission check. Spend is summed the same way as
   *  `costSummary` (phase-end + phase-error deltas).
   *
   *  OPTIONAL (added with root `limits`): without it `limits` cannot be
   *  checked, and fires are admitted with a warning. */
  orchestrationUsage?(
    orchestrationName: string,
    window: { dayStart: number; monthStart: number },
  ): Promise<{ runsToday: number; todayUsd: number; monthUsd: number }>;

  /** Record a trigger delivery (P0 durable ingress) before its run is
   *  created.
   *
   *  Returns false when a row for this (header idempotency key,
   *  orchestration) already exists — i.e. the unique index rejected it. That
   *  makes the insert itself the dedupe boundary: the preceding
   *  `findDeliveriesByKey` check is only a fast path, and two concurrent
   *  posts of one key used to both pass it and both insert. Never throws on
   *  that conflict; any other error still propagates. */
  recordDelivery(input: DeliveryInput): Promise<boolean>;

  /** Prior deliveries sharing an idempotency key, newest first. `sinceMs`
   *  bounds the lookup to a recent window — used for auto-derived keys so
   *  only accidental double-delivery is collapsed, not distinct-but-equal
   *  events.
   *
   *  `excludeRefused` drops `rejected` and `failed` rows. Dedupe passes it:
   *  a refusal means the work NEVER RAN, so letting it suppress a retry
   *  silently dropped the event — a provider re-sending a delivery we had
   *  refused (budget cap, missing orchestration) got a 200/duplicate and
   *  nothing happened. Matching only live-or-fired rows is what makes the
   *  key re-usable after a refusal, and it mirrors the partial unique index
   *  so the read and the constraint agree. */
  findDeliveriesByKey(
    key: string,
    opts?: {
      sinceMs?: number;
      excludeRefused?: boolean;
      /** Reference time for the `sinceMs` window. Defaults to `Date.now()`.
       *  Exists because the store computed that cutoff from its own clock
       *  while every other time-sensitive path takes an injectable one, so
       *  the window could not be driven deterministically in a test. */
      now?: number;
    },
  ): Promise<DeliveryRecord[]>;

  /** Patch a delivery's status / run linkage. */
  updateDelivery(id: string, patch: DeliveryPatch): Promise<void>;

  /** The most recent `polling` delivery for one source URL AND one
   *  orchestration, or null.
   *
   *  Exists so a polling trigger can seed its change-detection watermark on
   *  boot without re-firing an unchanged body. Scanning a fixed slice of
   *  `listDeliveries` instead was wrong twice over: on a busy server this
   *  source's last polling row falls outside the slice, so the watermark
   *  came back null and the first tick re-fired the unchanged body; and
   *  matching the URL alone let a newly-added orchestration inherit another
   *  one's watermark and never fire at all. */
  findLastPollingDelivery(
    source: string,
    orchestrationName: string,
  ): Promise<DeliveryRecord | null>;

  /** Recent deliveries, newest first. Owner-scoped when provided. Filter
   *  by status when given (drives the dead-letter / queue views). */
  listDeliveries(
    limit?: number,
    ownerId?: string,
    status?: DeliveryStatus,
  ): Promise<DeliveryRecord[]>;

  // ── Queue operations (P1): a durable work queue over deliveries ──────────

  /** Atomically claim the oldest claimable (`pending`, `available_at <= now`)
   *  delivery: flip it to `claimed`, stamp `claimed_at`, bump `attempts`.
   *  Postgres uses FOR UPDATE SKIP LOCKED (safe across many workers); SQLite
   *  uses a synchronous transaction (single process). Null when none.
   *
   *  `maxInFlightPerOrch` (P2 backpressure / fairness) skips deliveries whose
   *  orchestration already has that many `claimed` — so one orchestration's
   *  burst can't starve the others at dispatch. */
  claimNextDelivery(
    now: number,
    opts?: { maxInFlightPerOrch?: number },
  ): Promise<DeliveryRecord | null>;

  /** Mark a claimed delivery's run created — success terminal.
   *
   *  FENCED: `claimToken` must be the token the claim returned, and the row
   *  must still be `claimed`. Returns false when the fence does not match,
   *  meaning this worker LOST the claim (it stalled past the reclaim window
   *  and another worker now owns the delivery) — the caller must treat its
   *  own work as abandoned rather than assume success. An unfenced write
   *  here is how one accepted fire became two live runs. */
  completeDelivery(
    id: string,
    runId: string,
    now: number,
    claimToken: number,
  ): Promise<boolean>;

  /** Mark a delivery as durably PARKED behind a busy concurrency group: its
   *  fire is on the pending-fire queue and will run when the group frees.
   *  Terminal for the delivery, but NOT a dead letter — which is why it is
   *  not `rejectDelivery`. Fenced; see `completeDelivery`. */
  deferDelivery(
    id: string,
    detail: string,
    now: number,
    claimToken: number,
  ): Promise<boolean>;

  /** Refuse a delivery by policy (budget cap / missing orchestration) —
   *  terminal, not retried. Fenced; see `completeDelivery`. */
  rejectDelivery(
    id: string,
    reason: string,
    now: number,
    claimToken: number,
  ): Promise<boolean>;

  /** A worker run-creation attempt failed. With `retryAt`, requeue
   *  (`pending`, `available_at = retryAt`) for backoff; without it, the
   *  delivery is exhausted → `failed` (dead-letter). */
  failDelivery(
    id: string,
    opts: {
      error: string;
      now: number;
      retryAt?: number | null;
      /** The claim fence; see `completeDelivery`. Without it a stalled
       *  worker could requeue a delivery that another worker is mid-run on,
       *  producing a third run of the same fire. */
      claimToken: number;
    },
  ): Promise<boolean>;

  /** Make every not-yet-due `pending` delivery of one orchestration due NOW
   *  — the resume half of an intake pause, so held fires go immediately
   *  instead of on their next re-check. Returns how many rows moved. A row
   *  still over a limit is simply held again on its next claim.
   *
   *  OPTIONAL (added with intake pause): a store without it just lets held
   *  rows wait for their re-check. */
  releaseDeliveries?(orchestrationName: string, now: number): Promise<number>;

  /** HOLD a claimed delivery: back to `pending`, not claimable before
   *  `until`, and the claim's attempt REFUNDED. For an admission condition
   *  that is expected to clear on its own — the orchestration's intake is
   *  paused, a daily cap is spent, the spend budget is exhausted. Routing
   *  those through `failDelivery` burned the retry budget in seconds and
   *  dead-lettered a fire that was never wrong. Fenced; see
   *  `completeDelivery`.
   *
   *  OPTIONAL (added with intake holds): without it the worker falls back to
   *  `failDelivery` with a retry time — a hold that spends an attempt. */
  holdDelivery?(
    id: string,
    opts: { until: number; detail: string; claimToken: number },
  ): Promise<boolean>;

  /** Requeue deliveries stuck `claimed` longer than `olderThanMs` — their
   *  worker died mid-flight. Called on boot + periodically. */
  reclaimStaleDeliveries(
    olderThanMs: number,
    now: number,
  ): Promise<{ count: number; ids: string[] }>;

  /** Re-drive a dead-lettered (`failed`) or `rejected` delivery: reset to
   *  `pending`, available now, attempts cleared. Returns false if the id is
   *  unknown or not in a replayable state. */
  replayDelivery(id: string, now: number): Promise<boolean>;

  /** Count deliveries, optionally filtered — backpressure (P2) + stats (P5).
   *  `ownerId` scopes the count to one owner's rows, so the stats endpoint
   *  can answer per caller the way the list beside it does; the
   *  backpressure cap deliberately leaves it unset (the queue is shared). */
  countDeliveries(filter?: {
    status?: DeliveryStatus;
    orchestrationName?: string;
    ownerId?: string;
    /** Only rows claimable at or before this epoch ms — excludes HELD rows
     *  (see `holdDelivery`) from a backlog count. */
    availableBefore?: number;
    /** Backlog view at this epoch ms: rows that are due OR backing off after
     *  a failed attempt (`last_error` set) — but not HELD rows, whose
     *  `last_error` a hold clears. */
    dueOrRetrying?: number;
  }): Promise<number>;

  /** The delivery that produced a given run, if any — lets the eventing
   *  layer (P3) recover a run's chain depth from its triggering delivery. */
  findDeliveryByRunId(runId: string): Promise<DeliveryRecord | null>;

  // ── Trigger-fire outcomes (cron circuit-breaker) ───────────────────────

  /** Record one terminal trigger-fire outcome, keyed by a STABLE trigger
   *  key (e.g. `cron:<orch>:<expr>`). `status` is the run's final status;
   *  'done' resets the failure streak, anything else extends it. */
  recordTriggerOutcome(
    triggerKey: string,
    runId: string,
    status: string,
  ): Promise<void>;

  /** Trailing count of CONSECUTIVE non-`done` outcomes for a trigger, newest
   *  first, stopping at the first `done`. Drives the cron circuit-breaker:
   *  the API alerts (and opt-in auto-pauses) once this reaches a threshold. */
  getConsecutiveFailures(triggerKey: string): Promise<number>;

  // ── Concurrency groups (mutual exclusion) ──────────────────────────────

  /** Active (status in 'running' / 'paused') run headers whose
   *  `concurrencyGroup` equals `group`, excluding `excludeRunId` when given.
   *  The start-gate checks this before creating a run: a non-empty result
   *  means the group is busy. */
  findActiveRunsInGroup(
    group: string,
    excludeRunId?: string,
  ): Promise<RunHeader[]>;

  /** Record that one more fire was suppressed onto this delivery.
   *
   *  `'duplicate'` is a valid DeliveryStatus that nothing ever wrote, so a
   *  suppressed fire left no trace and the stats endpoint's duplicate bucket
   *  was permanently 0 — a provider double-sending was invisible. A row per
   *  suppressed fire would be unbounded writes driven by whoever is
   *  retrying; a counter on the row that won the key is bounded. */
  noteDuplicateSuppressed(id: string): Promise<void>;

  /** Total fires suppressed across all deliveries — the honest version of
   *  the stats endpoint's duplicate metric. `ownerId` scopes it to one
   *  owner's rows (the stats endpoint is owner-scoped like its list). */
  sumDuplicatesSuppressed(ownerId?: string): Promise<number>;

  /** Try to take the DURABLE lock for a concurrency group.
   *
   *  One atomic upsert: it succeeds only when no row exists or the existing
   *  one has EXPIRED. This is what makes the start-gate safe across
   *  PROCESSES — its in-memory `GroupLock` serializes one process, so two
   *  servers (or a server plus the standalone worker) sharing a store could
   *  otherwise both pass the "no active run in this group" check at the same
   *  instant and both create a run.
   *
   *  `ttlMs` bounds the hold. A holder that crashes never releases, so a
   *  lock without expiry would wedge its group permanently — worse than the
   *  race. Keep the TTL comfortably above the gate's critical section (a
   *  check plus a run-row insert), NOT the run's lifetime: the lock guards
   *  the decision, not the work. */
  acquireGroupLock(
    group: string,
    holder: string,
    ttlMs: number,
    now?: number,
  ): Promise<boolean>;

  /** Release a durable group lock. Only the `holder` that took it can, so a
   *  process whose lock already expired and was taken by someone else cannot
   *  release theirs. */
  releaseGroupLock(group: string, holder: string): Promise<void>;

  /** Park a trigger fire on the durable pending-fire queue for a group (the
   *  `queue` policy). Drained FIFO by {@link dequeueNextPendingFire} when a
   *  run in the group terminates. */
  enqueuePendingFire(group: string, fire: PendingFire): Promise<void>;

  /** Atomically remove + return the OLDEST parked fire for a group (FIFO by
   *  insertion id), or null when none. Called by the terminal drain to start
   *  one queued fire per terminating run. */
  dequeueNextPendingFire(group: string): Promise<PendingFire | null>;

  /** Count parked fires for a group — observability / tests. */
  countPendingFires(group: string): Promise<number>;

  /** Every parked fire (optionally for one group), oldest-first (the FIFO
   *  order {@link dequeueNextPendingFire} drains in). Read-only — powers the
   *  queue-visibility endpoint; never mutates the queue. */
  listPendingFires(group?: string): Promise<PendingFireRecord[]>;

  /** Withdraw ONE parked fire by its FIFO id WITHOUT starting it — the
   *  operator's "don't run this queued work" verb. Before this existed the
   *  only way a fire left the queue was a drain, which HATCHES it — so
   *  bulk-cancelling a group necessarily started each queued run just to
   *  cancel it. `group`, when given, makes the delete group-conditional in
   *  the same statement (an id/group mismatch removes nothing). Atomic with
   *  respect to a concurrent drain: exactly one of them gets the row; the
   *  loser sees null (the fire already started, or was already withdrawn). */
  withdrawPendingFire(
    id: number,
    group?: string,
  ): Promise<PendingFireRecord | null>;

  // ── Retention (opt-in pruning of old terminal runs) ────────────────────

  /** Delete TERMINAL runs — status 'done' / 'error' / 'cancelled', NEVER
   *  'paused' / 'interrupted' / 'running' — whose end time (endedAt, falling
   *  back to updatedAt for a terminal row that never stamped one) is older
   *  than `olderThanMs` before `now`, cascading their events. This is the
   *  retention seam: an unbounded runs.db (a real one hit 268 MB of
   *  per-chunk phase-delta events) only ever loses runs that are finished
   *  AND old; anything resumable or in flight is untouchable by design.
   *  `reclaimedBytes` is the backing file's measured shrink when the backend
   *  can cheaply compact + measure (SQLite: VACUUM after a non-empty prune);
   *  null when it can't (Postgres: autovacuum reclaims asynchronously). */
  pruneTerminalRuns(
    olderThanMs: number,
    now: number,
  ): Promise<{ count: number; reclaimedBytes: number | null }>;

  /** Prune TERMINAL delivery rows older than `olderThanMs`.
   *
   *  Retention used to cover `runs` + `events` only, so `trigger_deliveries`
   *  grew without bound — one row per cron tick, forever. It is also the
   *  DEDUPE table: header-key idempotency is "has this key been seen", so
   *  the guarantee was quietly resting on a table nobody ever trimmed.
   *
   *  Only terminal statuses go: `fired` / `rejected` / `deferred` /
   *  `duplicate` / `failed`. Never `pending` or `claimed` — those are live
   *  work — and `failed` is kept because it is the dead-letter view an
   *  operator replays from, so it is pruned on the same (deliberately
   *  opt-in) schedule rather than silently.
   *
   *  Pruning a row forgets its idempotency key, so a sender replaying that
   *  key after the retention window will fire again. That is the correct
   *  trade for a bounded table, and the window is the operator's choice. */
  pruneTerminalDeliveries(
    olderThanMs: number,
    now: number,
  ): Promise<{ count: number }>;

  /** Release the backend connection. */
  close(): Promise<void>;
}

/**
 * Open the run store. `DATABASE_URL` set → Postgres; otherwise the
 * zero-infra SQLite file at `<repoRoot>/runs.db`.
 *
 * Async because the Postgres backend connects + provisions its schema
 * during init; the SQLite backend's init is cheap.
 */
export async function openRunStore(repoRoot: string): Promise<RunStore> {
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    const { PostgresRunStore } = await import('./postgres-store');
    const store = new PostgresRunStore(url);
    await store.init();
    return store;
  }
  const { SqliteRunStore } = await import('./db');
  const store = new SqliteRunStore(repoRoot);
  await store.init();
  return store;
}

/**
 * One-time import of legacy file-based runs (`runs/*.json`) into
 * whatever store is active. Backend-agnostic — it only uses the
 * RunStore interface. Files are left in place as a backup.
 */
export async function importLegacyRunFiles(
  store: RunStore,
  runsDir: string,
): Promise<{ imported: number; skipped: number; errors: number }> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(runsDir);
  } catch {
    return { imported: 0, skipped: 0, errors: 0 };
  }
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(
        await fs.readFile(path.join(runsDir, f), 'utf8'),
      );
      if (!parsed?.id || typeof parsed.id !== 'string') {
        errors += 1;
        continue;
      }
      if (await store.getRun(parsed.id)) {
        skipped += 1;
        continue;
      }
      const status: RunStatus =
        parsed.status === 'done' ||
        parsed.status === 'error' ||
        parsed.status === 'cancelled' ||
        parsed.status === 'paused'
          ? parsed.status
          : parsed.endedAt
            ? 'done'
            : // A legacy "running" row can't be resumed — its owning
              // client-side executor is long gone. Mark it cancelled.
              'cancelled';
      await store.upsertRun({
        id: parsed.id,
        orchestrationName:
          typeof parsed.orchestrationName === 'string'
            ? parsed.orchestrationName
            : 'unknown',
        startedAt:
          typeof parsed.startedAt === 'number'
            ? parsed.startedAt
            : Date.now(),
        endedAt: typeof parsed.endedAt === 'number' ? parsed.endedAt : null,
        status,
        events: Array.isArray(parsed.events) ? parsed.events : [],
        orchestrationSnapshot: parsed.orchestrationSnapshot ?? null,
        initialInput:
          typeof parsed.initialInput === 'string'
            ? parsed.initialInput
            : null,
      });
      imported += 1;
    } catch {
      errors += 1;
    }
  }
  return { imported, skipped, errors };
}

// ── Cron circuit-breaker decision (reusable) ──────────────────────────────

/** Default consecutive-failure threshold before the breaker trips. Override
 *  per-process with SAMMY_CRON_FAILURE_THRESHOLD. */
export const DEFAULT_CRON_FAILURE_THRESHOLD = 3;

/** Resolve the configured threshold from the environment, falling back to
 *  {@link DEFAULT_CRON_FAILURE_THRESHOLD} for an unset / non-positive / NaN
 *  value. Centralized so the API and tests agree on the parse rules. */
export function cronFailureThreshold(
  env: Record<string, string | undefined> = process.env,
): number {
  const n = Number(env.SAMMY_CRON_FAILURE_THRESHOLD);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_CRON_FAILURE_THRESHOLD;
}

/**
 * The breaker's decision for one trigger, given a store: record the terminal
 * outcome, then read the consecutive-failure streak and compare to the
 * threshold. PURE of any side effects beyond the two store calls — the caller
 * decides what to DO when `tripped` (log an alert, opt-in auto-pause). This is
 * the reusable seam so the API wiring stays a thin call, and any other
 * trigger-completion path (a future worker hook) can reuse the same logic.
 *
 * Returns `{ failures, threshold, tripped }`. `tripped` is `failures >=
 * threshold`.
 */
export async function checkConsecutiveFailures(
  store: Pick<RunStore, 'recordTriggerOutcome' | 'getConsecutiveFailures'>,
  triggerKey: string,
  runId: string,
  status: string,
  threshold: number = cronFailureThreshold(),
): Promise<{ failures: number; threshold: number; tripped: boolean }> {
  await store.recordTriggerOutcome(triggerKey, runId, status);
  const failures = await store.getConsecutiveFailures(triggerKey);
  return { failures, threshold, tripped: failures >= threshold };
}

// ── Stale-gate TTL (a run paused at a human gate, forgotten) ───────────────
//
// PROBLEM: a run that snapshot+pauses at a `lock` gate sits `paused` forever
// if nobody approves it — and `paused` still HOLDS its concurrency group, so
// every subsequent trigger fire for that group queues silently behind it. A
// real run held its group for days; the only signal was one console.log at
// queue time. This section is the reusable core of the fix (mirroring how the
// cron circuit-breaker keeps its decision here and the API wiring thin):
// derive when a run paused, detect the TTL crossing, mark it durably (so a
// restart doesn't re-notify), and hand the crossing to a caller-supplied
// callback that owns the side effects (webhook / log / auto-cancel).

/** Default stale-gate TTL, hours. Override with SAMMY_GATE_TTL_HOURS. */
export const DEFAULT_GATE_TTL_HOURS = 24;

/** The durable "already notified for this pause" marker appended to a stale
 *  run's event stream. Scoped per PAUSE LEG: a marker only counts if it was
 *  appended after the run's latest `run-paused`, so a resume + re-pause that
 *  crosses the TTL again notifies again (it is a new wait). */
export const GATE_STALE_EVENT_TYPE = 'gate-stale';

/** Resolve the stale-gate TTL in MILLISECONDS from the environment.
 *  SAMMY_GATE_TTL_HOURS is a float; `0` explicitly DISABLES the sweep
 *  (returns 0). Unset / non-numeric / negative fall back to the 24 h default
 *  — a malformed value must not silently switch a safety net off (same
 *  fallback posture as {@link cronFailureThreshold}). */
export function gateTtlMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SAMMY_GATE_TTL_HOURS;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_GATE_TTL_HOURS * 3_600_000;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_GATE_TTL_HOURS * 3_600_000;
  return n * 3_600_000; // 0 stays 0 → disabled.
}

/** What the sweep does when a run crosses the TTL. 'notify' (default) alerts
 *  and leaves the run paused; 'cancel' additionally auto-cancels it — which
 *  frees its concurrency group via the normal cancel path, unblocking the
 *  fires queued behind it. Unknown values fall back to 'notify' (never
 *  auto-cancel by surprise on a typo). */
export type GateTtlAction = 'notify' | 'cancel';

export function gateTtlAction(
  env: Record<string, string | undefined> = process.env,
): GateTtlAction {
  return env.SAMMY_GATE_TTL_ACTION?.trim().toLowerCase() === 'cancel'
    ? 'cancel'
    : 'notify';
}

/** Epoch ms the run entered its CURRENT pause — the ts of the latest
 *  `run-paused` event. Falls back to `fallbackMs` (callers pass the header's
 *  `updatedAt`, the last write before the run went quiet) for a paused row
 *  with no such event (legacy import / manual upsert). */
export function derivePausedSinceMs(
  events: ReadonlyArray<StoredEvent>,
  fallbackMs: number,
): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (
      e.type === 'run-paused' &&
      typeof e.ts === 'number' &&
      Number.isFinite(e.ts)
    ) {
      return e.ts;
    }
  }
  return fallbackMs;
}

/** True when a {@link GATE_STALE_EVENT_TYPE} marker exists AFTER the latest
 *  `run-paused` — i.e. this pause leg has already been notified. Scanning
 *  backwards, the first marker hit wins and the first `run-paused` hit ends
 *  the leg (an older marker belongs to a previous pause and doesn't count). */
export function staleNotifiedSincePause(
  events: ReadonlyArray<StoredEvent>,
): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].type;
    if (t === GATE_STALE_EVENT_TYPE) return true;
    if (t === 'run-paused') return false;
  }
  return false;
}

/** One paused run past the TTL, as the sweep reports it. `pausedSinceMs` is
 *  an EPOCH timestamp (when the run paused), not a duration — subtract from
 *  now for the age. Matches the startedAt/endedAt convention everywhere else. */
export type StaleGateEntry = {
  runId: string;
  orchestrationName: string;
  /** The gated phase the run is waiting at (header `pausedFor`), if known. */
  pausedFor: string | null;
  pausedSinceMs: number;
};

/**
 * One stale-gate sweep over the store: find every `paused` run whose pause
 * age exceeds `ttlMs`, durably mark each NEW crossing (append one
 * {@link GATE_STALE_EVENT_TYPE} event — so the notification fires once per
 * pause leg, across sweeps AND restarts), and invoke `onStale` for it. The
 * callback owns the side effects (webhook, console alert, auto-cancel) so
 * this stays pure of API machinery and unit-testable against a bare store —
 * the same thin-wiring split as {@link checkConsecutiveFailures}.
 *
 * Returns EVERY currently-stale entry (newly marked or not) so the caller can
 * refresh an in-memory "stale" snapshot for cheap list decoration.
 *
 * Ordering note: the marker is appended BEFORE `onStale` runs — a crash in
 * between loses that one notification (at-most-once) rather than risking a
 * re-notify storm on every restart, which is the right trade for a nag.
 * Per-run failures are swallowed so one poisoned run can't hide the rest;
 * `ttlMs <= 0` disables the sweep entirely (returns []).
 */
export async function sweepStaleGates(
  store: Pick<RunStore, 'listPausedRuns' | 'getRun' | 'appendEvent'>,
  opts: {
    ttlMs: number;
    now?: number;
    /** Recorded on the marker event — the durable trace of what the sweep
     *  did (or was configured to do) at crossing time. */
    action?: GateTtlAction;
    /** Fired ONCE per run per TTL-crossing (per pause leg). `run` is the
     *  full hydrated run so the caller can read its orchestrationSnapshot
     *  (for the notify webhook URL) without a second fetch. */
    onStale?: (entry: StaleGateEntry, run: Run) => void | Promise<void>;
  },
): Promise<StaleGateEntry[]> {
  const { ttlMs } = opts;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return []; // 0 = disabled.
  const now = opts.now ?? Date.now();
  const stale: StaleGateEntry[] = [];
  const headers = await store.listPausedRuns();
  for (const h of headers) {
    if (h.status !== 'paused') continue; // defensive; the query filters
    // A run parked on a durable `wait` is paused, but it is NOT an
    // abandoned human gate — nobody is supposed to approve it, and its
    // staleness policy is the wait itself (the wait sweeper resumes due
    // timers; a signal wait bounds itself via timeoutSeconds). Without
    // this skip a legitimate multi-day timer trips the gate TTL: nag
    // notifies at best, and SAMMY_GATE_TTL_ACTION=cancel auto-cancels a
    // healthy waiting run at worst.
    if (pendingWaitOf(h.stateJson)) continue;
    try {
      // Hydrate only paused runs (rare) — the pause timestamp and the
      // notified-marker both live in the event stream.
      const run = await store.getRun(h.id);
      if (!run || run.status !== 'paused') continue; // resumed under us
      const pausedSinceMs = derivePausedSinceMs(run.events, run.updatedAt);
      if (now - pausedSinceMs < ttlMs) continue; // not stale yet
      const entry: StaleGateEntry = {
        runId: run.id,
        orchestrationName: run.orchestrationName,
        pausedFor: run.pausedFor,
        pausedSinceMs,
      };
      stale.push(entry);
      if (staleNotifiedSincePause(run.events)) continue; // this leg already alerted
      // Durable marker first (once per leg, restart-safe), then the callback.
      // appendEvent's lease fence allows writes to a non-`running` run.
      await store.appendEvent(run.id, {
        type: GATE_STALE_EVENT_TYPE,
        phaseName: run.pausedFor ?? 'unknown',
        pausedSinceMs,
        ttlMs,
        action: opts.action ?? 'notify',
        ts: now,
      });
      await opts.onStale?.(entry, run);
    } catch {
      // One bad run (store hiccup, torn event JSON) must not stop the sweep
      // from checking the rest; the next sweep retries it.
    }
  }
  return stale;
}

// ── Runs retention (opt-in) ────────────────────────────────────────────────

/** Resolve SAMMY_RUN_RETENTION_DAYS: a positive float enables retention with
 *  that window; unset / 0 / negative / non-numeric all mean OFF (null).
 *  Deliberately opt-in with no default — deleting history must be an explicit
 *  operator decision, unlike the gate TTL (which only alerts by default). */
export function runRetentionDays(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env.SAMMY_RUN_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
