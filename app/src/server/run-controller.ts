/**
 * Manages server-owned orchestration runs over a durable RunStore
 * (SQLite or Postgres — the controller is backend-agnostic).
 *
 * Lifecycle:
 *   startRun() → upsert row, launch executor in background, return id
 *      ↓
 *   executor emits events → persist to the store + mirror in memory +
 *      broadcast to attached SSE subscribers
 *      ↓
 *   on finish/error/abort → write final status → send sentinel →
 *      close subscribers → drop from the in-memory map
 *
 * Subscriber semantics: a live run's events are mirrored in
 * `ctrl.events`. `subscribe()` to a live run snapshots that array and
 * attaches a listener in one synchronous step — so no event can be
 * missed or duplicated between the replay and the attach, even though
 * the store itself is async. A finished run is replayed from the
 * store (it's over — nothing can race in).
 *
 * The store is the durable source of truth. The in-memory map only
 * holds non-serializable state (AbortController, subscriber callbacks)
 * plus the live event mirror, which is freed when the run finishes.
 */

import { randomUUID } from 'node:crypto';
import { RunPauseRequested, type PendingWaitSpec } from '../llm/executor';
import { deriveWaitState, type WaitSeed } from './wait-resolution';
import { externalKillSignal } from '../llm/terminal-failure';
import { type BudgetGate, checkGateBreach } from './budget-store';
import { DurableGroupLock } from './concurrency-group';
import {
  computeDegradation,
  type DegradationReason,
} from './degradation';
import {
  computeDivergence,
  type DivergenceConfig,
  type DivergenceResult,
} from './divergence';
import { computeRunNotes, type RunNotes } from './run-notes';
import { priorCrossedLocks } from './gate-invalidation';
import { descendantPids, reapNewDescendants } from './reap';
import {
  DEFAULT_LEASE_TTL_MS,
  LeaseLostError,
  type RunStatus,
  type RunStore,
  type RunSummary,
  type StoredEvent,
} from './run-store';

// How often a running run renews its lease on a timer (independent of event
// emission). Comfortably under the default TTL so a phase that emits no events
// for a while — a long non-streaming model call — never lets its lease lapse.
const LEASE_RENEW_MS = Math.max(5_000, Math.floor(DEFAULT_LEASE_TTL_MS / 3));

// The terminal write is retried this many times, with a growing pause, before
// the leg gives up on recording its status. Sized for the transient failures
// that actually hit a last write (SQLITE_BUSY, a dropped connection, a
// statement timeout) — not for an outage, which the lease machinery handles.
const TERMINAL_WRITE_ATTEMPTS = 3;
const TERMINAL_WRITE_BACKOFF_MS = 250;

// Grace between an abort and the direct child reap, so the SDK abort gets a
// moment to kill the direct `claude` subprocess first.
const ABORT_REAP_DELAY_MS = 1_500;

/** resume()'s per-store group lock. The store-backed lock is the SAME row
 *  the API's start-gate takes (keyed by group), so a resume and a fresh start
 *  for one group exclude each other across processes; the in-process half
 *  keeps two same-process resumes off the database. One per store so tests
 *  with several stores never share a lock. */
const resumeGroupLocks = new WeakMap<RunStore, DurableGroupLock>();
function resumeGroupLockFor(store: RunStore): DurableGroupLock {
  let lock = resumeGroupLocks.get(store);
  if (!lock) {
    lock = new DurableGroupLock(store, {
      holder: `resume-${process.pid}-${randomUUID().slice(0, 8)}`,
      log: m => console.warn(`[run-controller] concurrency: ${m}`),
    });
    resumeGroupLocks.set(store, lock);
  }
  return lock;
}

/** Async generator the caller hands us; for each yielded event we
 *  persist + broadcast. Whatever app/src/llm/executor.ts emits. The run
 *  id is passed in so the builder can thread it to the executor (e.g.
 *  for attributing queued agent dispatches to this run). */
type EventSource = (
  signal: AbortSignal,
  runId: string,
) => AsyncIterable<StoredEvent>;

type SendFn = (event: StoredEvent) => void;

type ActiveRun = {
  id: string;
  abortController: AbortController;
  listeners: Set<SendFn>;
  /** Live event mirror — every event delivered so far. Lets subscribe()
   *  replay a live run without a (racy, async) store read. Freed when
   *  the run leaves the active map. */
  events: StoredEvent[];
  /** Set once the executor finishes (any terminal status). Late
   *  subscribers get history + a sentinel + an immediate close. */
  finished: boolean;
  /** Optional A2A push-notification webhook. When set, every event is
   *  fire-and-forget POSTed to this URL. In-memory only — registered
   *  via setPushNotification(); lost on process restart. */
  pushUrl?: string;
  /** Snapshot of this server process's descendant PIDs taken at run START,
   *  BEFORE the executor begins. Pre-existing descendants (esbuild, vite
   *  watcher, other concurrent runs' processes) are exempt from the
   *  terminal reaper so only THIS run's spawned orphans get killed. */
  procBaseline: Set<number>;
};

const active = new Map<string, ActiveRun>();

export type StartRunOpts = {
  /** The run's declared inputs, resolved (a Jira key → the ticket's text).
   *  Persisted in the checkpoint so a leg that resumes — after an approval
   *  gate, a restart, a durable wait — seeds `${name}` the same way; nothing
   *  re-resolves them. */
  resolvedInputs?: Record<string, string>;
  store: RunStore;
  orchestrationName: string;
  initialInput?: string;
  orchestrationSnapshot?: unknown;
  /** Factory the controller calls with the run's AbortSignal. Returns
   *  the AsyncIterable of events to consume. */
  buildEventSource: EventSource;
  /** Optional server-side spend cap. When set, the controller sums the
   *  run's cost and aborts it the moment that cost would push total
   *  daily / monthly spend past the cap. */
  budgetGate?: BudgetGate;
  /** Owner identity. Defaults to 'system' for the single-tenant path. */
  ownerId?: string;
  /** Concurrency-group to stamp on the run's header (the orchestration root's
   *  `concurrency.group`). Recorded so the start-gate can detect overlap and
   *  the terminal drain can release a parked fire. Omit / null for an
   *  orchestration with no `concurrency` block. */
  concurrencyGroup?: string | null;
  /** Fired after the run's final status is persisted. Used by the API
   *  layer to wire workflow-level `lifecycle.errorOrchestration` — when
   *  `status === 'error'`, look up + start the recovery orchestration.
   *  Not awaited (fire-and-forget); throws inside it are swallowed.
   *  `degraded`/`degradationReasons` carry the "done-but-degraded" verdict
   *  (always false / [] for a non-`done` terminal) so the hook can fold it
   *  into the notify text. */
  onTerminal?: (info: TerminalInfo) => void | Promise<void>;
  /** Run-level thrash / retry-storm watchdog config (the orchestration root's
   *  `notify.divergence`). Omit for the default WARN-only behavior at the
   *  default repeat threshold. `abort: true` makes the controller abort a
   *  thrashing run mid-flight; otherwise it only emits a `run-divergence`
   *  event + records the verdict at terminal. */
  divergence?: DivergenceConfig;
};

/** What the `onTerminal` hook receives. */
export type TerminalInfo = {
  id: string;
  status: RunStatus;
  error: string | null;
  /** "done-but-degraded" verdict — only ever true on a `done` terminal. */
  degraded: boolean;
  degradationReasons: DegradationReason[];
  /** Run-level thrash verdict (retry-storm watchdog). `diverged` is true when
   *  a phase instance re-ran past the threshold; always computed (independent
   *  of status) so the hook can fold a `RETRY STORM: …` line into the notify. */
  divergence: DivergenceResult;
  /** Structured human-readable run-end summary (per-item verdicts + run
   *  totals + health flags), derived from the durable event stream. The hook
   *  folds its compact text form into the notify webhook. */
  notes: RunNotes;
  /** Set when the leg concluded `status` but could NOT record it after every
   *  retry: the row still reads `running` and, with this leg's heartbeat
   *  stopped and the controller gone from the active map, the orphan sweep
   *  (this process's own, or a peer's) will reclaim it as `interrupted`. The
   *  hook still fires so nothing downstream is stranded, but `status` is what
   *  the leg concluded, not what the store says. */
  terminalWriteError?: string;
};

/** ISO-ish run id — roughly sortable, uniquely identifiable. */
function newRunId(): string {
  const t = Date.now();
  const r = Math.random().toString(36).slice(2, 8);
  return `run-${t}-${r}`;
}

/** Start a new server-owned run. Awaits the initial row insert (so an
 *  immediate subscribe finds the run), then returns the id; the
 *  executor runs in the background. */
export async function startRun(opts: StartRunOpts): Promise<{ id: string }> {
  const id = newRunId();
  const ctrl: ActiveRun = {
    id,
    abortController: new AbortController(),
    listeners: new Set(),
    events: [],
    finished: false,
    // Baseline the server's descendant tree BEFORE the executor spawns
    // anything. Anything not in here that's a descendant at terminal time
    // was spawned by this run and is attributable to it.
    procBaseline: descendantPids(process.pid),
  };
  // Registered BEFORE the row exists. The id is private until this returns,
  // so nothing can act on the controller early — but the moment the insert
  // lands the row is public, and a store-path cancel that flipped it before
  // the old post-insert registration found no controller to abort: it
  // appended its sentinel and drained the group while this leg started
  // against the cancelled row. Registered first, that cancel aborts the
  // signal the executor is about to be handed (runInBackground honours an
  // abort that fired before the source was built).
  active.set(id, ctrl);
  try {
    await opts.store.upsertRun({
      id,
      orchestrationName: opts.orchestrationName,
      startedAt: Date.now(),
      status: 'running',
      events: [],
      orchestrationSnapshot: opts.orchestrationSnapshot ?? null,
      initialInput: opts.initialInput ?? null,
      ownerId: opts.ownerId,
      concurrencyGroup: opts.concurrencyGroup ?? null,
    });
    // The resolved inputs go in the row NOW, not at the first checkpoint: a
    // run interrupted during its first step (a restart, a crash) otherwise
    // resumes with no `${ticket}` at all — nothing re-resolves them.
    if (opts.resolvedInputs) {
      // Best-effort: every checkpoint writes them again, so a failed write
      // here only narrows the first-step window — never fail the start on it.
      await opts.store
        .updateRunStatus(id, { stateJson: { leafOutputs: {}, resolvedInputs: opts.resolvedInputs } })
        .catch(err => console.warn(`[run-controller] storing ${id}'s inputs at start failed (ignored):`, err));
    }
  } catch (err) {
    active.delete(id);
    throw err;
  }

  // Fire-and-forget — the HTTP handler returns the id immediately.
  void runInBackground(
    opts.store,
    id,
    opts.buildEventSource,
    ctrl,
    opts.budgetGate,
    opts.resolvedInputs
      ? { completedLeaves: [], leafOutputs: {}, lastOutput: null, resolvedInputs: opts.resolvedInputs }
      : undefined,
    opts.onTerminal,
    opts.divergence,
  );

  return { id };
}

async function runInBackground(
  store: RunStore,
  id: string,
  buildEventSource: EventSource,
  ctrl: ActiveRun,
  budgetGate?: BudgetGate,
  /** Pre-resume state — seeded by resume(), empty for a fresh run. */
  seed?: {
    completedLeaves: string[];
    leafOutputs: Record<string, string>;
    lastOutput: string | null;
    resolvedInputs?: Record<string, string>;
  },
  onTerminal?: (info: TerminalInfo) => void | Promise<void>,
  /** Run-level divergence (retry-storm) watchdog config. Default WARN-only. */
  divergence?: DivergenceConfig,
): Promise<void> {
  let finalStatus: RunStatus = 'done';
  let finalError: string | null = null;
  let pausedAt: string | null = null;
  /** Set when the pause is a parked `wait` leaf (durable timer / signal) —
   *  persisted into stateJson.pendingWait so the wait sweeper can spot a due
   *  run from its header alone. Null for human lock-gate pauses. */
  let pausedWait: PendingWaitSpec | null = null;
  let executorEmittedTerminal: 'error' | 'cancelled' | 'done' | null = null;
  const leafPhaseNames = new Set<string>();
  // Incremental thrash counter — only maintained when `divergence.abort` is on,
  // so the default path carries ZERO per-event overhead. Keyed by a leaf's
  // scoped replayKey (falling back to phaseName) so the SAME item's re-runs
  // accumulate while distinct fan-out items stay separate (see divergence.ts).
  const divergenceAbort = divergence?.abort === true;
  const divergenceThreshold = Math.max(
    2,
    Math.floor(divergence?.repeatThreshold ?? 6),
  );
  const repeatCounts = new Map<string, number>();
  let divergenceAborted = false;
  const completedLeaves: string[] = [...(seed?.completedLeaves ?? [])];
  const leafOutputs: Record<string, string> = { ...(seed?.leafOutputs ?? {}) };
  let lastOutput: string | null = seed?.lastOutput ?? null;
  // Carried in every checkpoint (stateJson is replaced wholesale).
  const resolvedInputs = seed?.resolvedInputs;
  let runCostUsd = 0;
  let budgetHalt: string | null = null;

  /** Mirror an event in memory + fan it out to live subscribers. Pure
   *  synchronous — no event can be missed between the mirror push and
   *  the broadcast. Also fire-and-forgets an A2A push webhook if one
   *  is registered on this run. */
  const deliver = (event: StoredEvent): void => {
    ctrl.events.push(event);
    for (const send of [...ctrl.listeners]) {
      try {
        send(event);
      } catch {
        ctrl.listeners.delete(send);
      }
    }
    if (ctrl.pushUrl) {
      // Fire-and-forget: don't await, don't retry, don't block the
      // run on a slow / dead webhook.
      void fetch(ctrl.pushUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: id, event }),
      }).catch(() => {
        /* webhook unreachable — drop silently */
      });
    }
  };

  // Interval heartbeat — keep the lease fresh through a phase that emits no
  // events (a long non-streaming model call). appendEvent also renews the
  // lease, but a silent phase past the TTL would otherwise be reclaimable
  // mid-flight, and the reclaiming peer would re-run that phase's external side
  // effects. The renew is fenced store-side (it can never steal a lease); if it
  // reports the lease is gone, stop ticking. unref'd so it never holds the
  // process open. The lease is already claimed (upsertRun / updateRunStatus)
  // before runInBackground is invoked, so starting here is safe.
  //
  // LOSING THE LEASE ABORTS THE WORK, not just the ticking.
  //
  // This used to only `clearInterval` on loss. The run kept going: it carried
  // on dispatching agents, spending money and performing external side
  // effects until its NEXT `appendEvent` happened to throw `LeaseLostError` —
  // which, through a long silent phase, could be many minutes. Meanwhile the
  // peer that reclaimed it was executing the same run. The lease fenced the
  // LOG; it did not fence the WORK.
  //
  // Aborting here closes the gap to one in-flight tool call: the executor sees
  // the signal at its next checkpoint and unwinds. The store write is already
  // fenced, so nothing this leg does after the loss can corrupt the new
  // owner's record.
  //
  // Store errors were also swallowed entirely (`() => {}`) — a renewal failing
  // every tick looked identical to one succeeding. They are logged now;
  // a transient error does NOT abort (the next tick retries), only a definitive
  // "you no longer hold this" does.
  //
  // The abort is FLAGGED, not bare. The executor unwinds through its ordinary
  // abort path, which to the code below is indistinguishable from a user
  // cancel: finalStatus 'cancelled' and a terminal write. That terminal was
  // the bug — the reclaim had marked the row `interrupted` with its checkpoint
  // intact, and a `cancelled` stamped over it is terminal, so resume() refused
  // it: the checkpoint survived and the run was permanently unresumable
  // anyway. `leaseLost` routes the unwind to the same yield path a fenced
  // write's LeaseLostError takes, so NOTHING is written on the way out.
  let leaseLost = false;
  const renewTimer = setInterval(() => {
    void store.renewLease(id).then(
      held => {
        // Ticks already in flight when the loss lands resolve after it; the
        // loss is handled once.
        if (held || leaseLost) return;
        clearInterval(renewTimer);
        console.warn(
          `[run-controller] run ${id} LOST ITS LEASE — another process has ` +
            'reclaimed it. Aborting this leg so both are not executing the ' +
            'same run; the reclaiming owner continues from the checkpoint.',
        );
        leaseLost = true;
        ctrl.abortController.abort();
        // Same belt-and-suspenders reap cancel() schedules: the abort only
        // reaches the direct subprocess, and a leg that lost its lease is as
        // likely as any to be wedged on a hung tool that never lets the loop
        // unwind to the terminal reap. The children are ours locally whoever
        // owns the row now.
        scheduleAbortReap(id, 'cancelled', ctrl.procBaseline);
      },
      err => {
        // Transient: keep ticking, but do not do it silently.
        console.warn(
          `[run-controller] lease renewal for ${id} failed (will retry):`,
          err instanceof Error ? err.message : err,
        );
      },
    );
  }, LEASE_RENEW_MS);
  (renewTimer as unknown as { unref?: () => void }).unref?.();
  const stopRenew = () => clearInterval(renewTimer);

  /** Yield the run to the peer that reclaimed it. Local teardown ONLY — no
   *  sentinel, no status write, no terminal hook — so this leg can neither
   *  stomp the new owner's rows nor trigger a duplicate recovery. The
   *  spawned children are still ours locally, so they are reaped regardless
   *  of whose row it is now. */
  const yieldToPeer = async (why: string, reapAs: RunStatus): Promise<void> => {
    console.warn(`[run-controller] ${why}`);
    stopRenew();
    ctrl.abortController.abort();
    ctrl.finished = true;
    ctrl.listeners.clear();
    active.delete(id);
    await reapRunDescendants(id, reapAs, ctrl.procBaseline);
  };

  try {
    // The source attaches its abort listener only when it is built, so an
    // abort that already fired — a cancel landing between this leg's
    // registration and here — would never reach the executor, which would
    // then run to completion on a cancelled row. Unwind as the executor would
    // have, without starting work nobody can stop.
    if (ctrl.abortController.signal.aborted) {
      throw new Error(`run ${id} was cancelled before its executor started`);
    }
    for await (const event of buildEventSource(ctrl.abortController.signal, id)) {
      // Once a peer owns this run, nothing further from this leg is
      // persisted. The abort above makes the executor unwind, and that unwind
      // YIELDS — a leaf's phase-error, then the `run-cancelled` sentinel —
      // while appendEvent's fence only guards RUNNING rows: the reclaim marked
      // this one `interrupted`, so those events landed after the peer's
      // `run-interrupted` and a resumable row ended `…, run-cancelled`.
      if (leaseLost) break;
      // Persist first (the store is the durable record), then do any
      // checkpoint / budget writes — all awaits BEFORE the synchronous
      // deliver() so subscribe() can't interleave mid-event.
      await store.appendEvent(id, event);

      if (event.type === 'run-error') {
        if (ctrl.abortController.signal.aborted) {
          executorEmittedTerminal = 'cancelled';
        } else {
          executorEmittedTerminal = 'error';
          finalError = (event as { error?: string }).error ?? 'Run errored';
        }
      } else if (event.type === 'run-cancelled') {
        executorEmittedTerminal = 'cancelled';
      } else if (event.type === 'run-end') {
        executorEmittedTerminal = 'done';
      }

      if (event.type === 'phase-start') {
        const ev = event as { phaseName?: string; agentPath?: string };
        if (
          typeof ev.agentPath === 'string' &&
          typeof ev.phaseName === 'string'
        ) {
          leafPhaseNames.add(ev.phaseName);
        }
      } else if (event.type === 'phase-end') {
        const ev = event as {
          phaseName?: string;
          replayKey?: string;
          output?: string;
          costUsd?: number;
        };
        if (typeof ev.costUsd === 'number' && Number.isFinite(ev.costUsd)) {
          runCostUsd += ev.costUsd;
        }
        // Checkpoint key: the executor's explicit replayKey when present
        // (leaf events carry it; loop/map/subflow iterations get scoped
        // keys so repeated executions checkpoint independently). The
        // phase-start agentPath heuristic stays as the fallback for events
        // from executors that predate replay keys.
        const checkpointKey =
          typeof ev.replayKey === 'string'
            ? ev.replayKey
            : typeof ev.phaseName === 'string' && leafPhaseNames.has(ev.phaseName)
              ? ev.phaseName
              : null;
        if (checkpointKey && !leafOutputs[checkpointKey]) {
          completedLeaves.push(checkpointKey);
          if (typeof ev.output === 'string') {
            lastOutput = ev.output;
            leafOutputs[checkpointKey] = ev.output;
          }
          try {
            // FENCED: a checkpoint is a wholesale overwrite of the state the
            // new owner resumes from. appendEvent above was fenced; this was
            // not, so a process that stalled past the TTL and was reclaimed
            // could stamp its stale [a] over the peer's live [a, b, c].
            await store.updateRunStatus(
              id,
              {
                completedLeaves,
                lastOutput,
                stateJson: { leafOutputs, ...(resolvedInputs ? { resolvedInputs } : {}) },
              },
              { requireLease: true },
            );
          } catch (writeErr) {
            // A lost lease is not a transient write error: it means a peer
            // owns this run now, and every further write (and every further
            // phase's side effects) from this leg is a collision. Let it
            // reach the LeaseLostError handler below. Anything else is a
            // store hiccup the next checkpoint will paper over.
            if (writeErr instanceof LeaseLostError) throw writeErr;
            console.error(
              `[run-controller] checkpoint write failed for ${id}:`,
              writeErr,
            );
          }
        }
      } else if (event.type === 'phase-error') {
        // A leaf's failed attempt carries what it spent (no phase-end follows
        // a failure, and `retry` pays again). The gate has to count it, or a
        // retry storm burns under the cap unseen.
        const c = (event as { costUsd?: unknown }).costUsd;
        if (typeof c === 'number' && Number.isFinite(c)) runCostUsd += c;
      }

      // Mid-run budget halt — append the diagnostic before delivering.
      let haltEvent: StoredEvent | null = null;
      if (budgetGate && !budgetHalt) {
        const breach = checkGateBreach(budgetGate, runCostUsd);
        if (breach) {
          budgetHalt = breach;
          haltEvent = { type: 'budget-halted', reason: breach, ts: Date.now() };
          await store.appendEvent(id, haltEvent);
        }
      }

      // Mid-run divergence ABORT (opt-in). Only when `divergence.abort` is set
      // — the default path skips this block entirely (zero overhead). Maintain
      // an O(1) per-leaf-instance counter; the first instance to cross the
      // threshold means the run is thrashing (the same per-item phase grinding),
      // so emit a loud `run-divergence` event and abort — instead of letting the
      // storm burn the rest of the budget. `phase-end`/`node-retried` are the
      // re-run signals (mirrors computeDivergence's terminal-time derivation).
      let divergenceEvent: StoredEvent | null = null;
      if (
        divergenceAbort &&
        !divergenceAborted &&
        (event.type === 'phase-end' || event.type === 'node-retried')
      ) {
        const ev = event as { phaseName?: string; replayKey?: string };
        if (typeof ev.phaseName === 'string' && ev.phaseName.length > 0) {
          const key =
            typeof ev.replayKey === 'string' && ev.replayKey.length > 0
              ? ev.replayKey
              : ev.phaseName;
          const n = (repeatCounts.get(key) ?? 0) + 1;
          repeatCounts.set(key, n);
          if (n >= divergenceThreshold) {
            divergenceAborted = true;
            divergenceEvent = {
              type: 'run-divergence',
              phaseName: ev.phaseName,
              key,
              repeats: n,
              threshold: divergenceThreshold,
              aborted: true,
              ts: Date.now(),
            };
            await store.appendEvent(id, divergenceEvent);
          }
        }
      }

      deliver(event);
      if (haltEvent) {
        deliver(haltEvent);
        ctrl.abortController.abort();
      }
      if (divergenceEvent) {
        deliver(divergenceEvent);
        ctrl.abortController.abort();
      }
    }
  } catch (err) {
    if (err instanceof LeaseLostError) {
      // Another process reclaimed this run (we stalled past the lease TTL) and
      // is now its single writer. Yield WITHOUT touching the run's rows.
      await yieldToPeer(
        `${err.message}; stopping local execution of ${id}.`,
        'cancelled',
      );
      return;
    }
    if (err instanceof RunPauseRequested) {
      finalStatus = 'paused';
      pausedAt = err.pausedFor;
      pausedWait = err.wait ?? null;
    } else if (ctrl.abortController.signal.aborted) {
      finalStatus = 'cancelled';
    } else {
      finalStatus = 'error';
      finalError = (err as Error).message ?? String(err);
    }
  }

  // The renew handler aborted us because a PEER now owns this run. Whether the
  // event source threw on the signal (→ 'cancelled' above) or simply stopped
  // (→ 'done'), writing that terminal would stamp over the reclaim's
  // `interrupted` + checkpoint and leave the run unresumable. Checked here,
  // after the loop, so it covers both unwinds; checked BEFORE the terminal
  // block so nothing below runs.
  if (leaseLost) {
    await yieldToPeer(
      `run ${id} lost its lease mid-flight; skipping its terminal write.`,
      'cancelled',
    );
    return;
  }

  if (executorEmittedTerminal === 'error') finalStatus = 'error';
  else if (executorEmittedTerminal === 'cancelled') finalStatus = 'cancelled';
  else if (executorEmittedTerminal === 'done') finalStatus = 'done';

  // A budget halt overrides the abort-induced 'cancelled' — the run
  // didn't fail and wasn't user-cancelled; a spend cap stopped it.
  if (budgetHalt) {
    finalStatus = 'error';
    finalError = budgetHalt;
  }

  // A divergence ABORT (the retry-storm watchdog tripped with `abort: true`)
  // makes the run terminal `error` — the watchdog stopped a thrashing run,
  // which is a failure, not a clean finish or a user cancel. Mirrors budgetHalt.
  // Overrides whatever terminal the cut-short event source produced (a real
  // executor aborts mid-stream → 'cancelled'; a source that simply stops on the
  // abort signal would otherwise read 'done'). A genuine run-error/cancel from
  // another cause is left alone (only flip done/cancelled).
  if (divergenceAborted && (finalStatus === 'cancelled' || finalStatus === 'done')) {
    finalStatus = 'error';
    finalError =
      finalError ??
      'run aborted by the divergence watchdog — a phase was thrashing (retry storm)';
  }

  // External signal kills are NOT agent failures. "exited with code 143"
  // (host memory pressure SIGTERMing the SDK subprocess) used to land as
  // terminal `error` — dead end, full re-run. An externally-killed
  // subprocess is exactly the crash case checkpoints were built for, so
  // classify it `interrupted`: resumable in one click (or SAMMY_AUTO_RESUME
  // at boot), completed leaves replayed. Deliberate consequences: no
  // `<orch>.error` event and no errorOrchestration fire for a kill that
  // wasn't an agent failure (notify still fires with the status). Checked
  // AFTER the budget/divergence overrides — those set their own messages
  // and must stay `error`.
  if (finalStatus === 'error' && finalError) {
    const signal = externalKillSignal(finalError);
    if (signal) {
      finalStatus = 'interrupted';
      finalError =
        `${finalError} — classified as an EXTERNAL ${signal} kill (host ` +
        `memory pressure / operator), not an agent failure; the run is ` +
        `resumable from its checkpoints (POST /api/runs/:id/resume).`;
      console.warn(`[run-controller] ${id}: ${finalError}`);
    }
  }

  const endedAt = Date.now();

  // THE TERMINAL GUARD STARTS HERE, not at the write. Everything below — the
  // degradation / divergence / notes verdicts and the sentinel — is derived
  // from `ctrl.events`, a log this leg did not fully produce: a resumed leg
  // seeds the mirror from the store, and POST /api/runs accepts caller-supplied
  // event objects whose only validated fields are `type` and three numerics.
  // runInBackground is fire-and-forget, so one unguarded field read in a
  // derivation would reject the floating promise ABOVE stopRenew /
  // active.delete and leave exactly the lease-renewing zombie the retry
  // teardown below exists to prevent. Inside the guard a derivation failure
  // lands where a failed terminal write lands: the row keeps reading
  // `running`, this leg stops its heartbeat and leaves the active map, and the
  // orphan sweep reclaims it as `interrupted`. The verdicts below are the
  // CLEAN ones a terminal that never computed reports — the hook that reads
  // them also reads `terminalWriteError`.
  let degradation: { degraded: boolean; reasons: DegradationReason[] } = {
    degraded: false,
    reasons: [],
  };
  let divergenceResult: DivergenceResult = {
    diverged: false,
    threshold: divergenceThreshold,
    maxRepeats: 0,
    hotspots: [],
  };
  let notes: RunNotes = {
    runId: id,
    status: finalStatus,
    items: [],
    totals: {
      items: 0,
      succeeded: 0,
      failed: 0,
      incomplete: 0,
      promoted: 0,
      health: [],
    },
  };
  let sentinel: StoredEvent | null = null;
  let divergenceWarnEvent: StoredEvent | null = null;
  let terminalWriteError: string | null = null;
  /** Set once the verdicts + sentinel are built, so the refusal below names
   *  which half of the terminal failed rather than claiming a write that was
   *  never attempted. */
  let terminalComputed = false;
  try {
    // "done-but-degraded" verdict. A run that reaches `done` can still have
    // swallowed a phase error (continueOnError / finalizer / onError),
    // finalized a fan-out with partials, been stall-aborted on a node
    // and carried on, or taken a documented fallback — `status: done` masks all
    // of it. Derive the verdict from the durable event mirror (the same events
    // that were persisted) so it can't drift from what happened. Only a `done`
    // terminal can be degraded; an error/cancelled/paused run already signals
    // its outcome via `status`, so we leave the verdict clean for those.
    if (finalStatus === 'done') degradation = computeDegradation(ctrl.events);

    // Run-level thrash / retry-storm verdict (the WARN path). Always derived
    // from the full durable event mirror — independent of status, because a
    // thrashing run can end `done`, `error`, OR be cut short by the abort path
    // above. One O(events) scan at terminal (no per-phase overhead). When the
    // run diverged and the abort path did NOT already emit a `run-divergence`
    // event (warn-only mode, or it crossed the bar only in aggregate), emit one
    // now so the run log and any poller see the storm loudly. This is
    // observability — it never changes `finalStatus`.
    divergenceResult = computeDivergence(ctrl.events, divergence);
    // Structured human-readable run-end summary (per-item verdicts + run totals
    // + health flags). Folds in the degraded + divergence verdicts so the notes
    // are a single coherent end-of-run picture. Derived purely from the events.
    notes = computeRunNotes(ctrl.events, {
      runId: id,
      status: finalStatus,
      degradation,
      divergence: divergenceResult,
    });

    // Warn-path `run-divergence` event. When the run thrashed but the mid-run
    // abort path did NOT already emit one (warn-only mode is the default), emit
    // a single loud event now from the terminal-time verdict so the run log +
    // any poller see the storm. `aborted: false` distinguishes it from the
    // abort-path event. Best-effort, fenced like the other terminal writes.
    if (divergenceResult.diverged && !divergenceAborted) {
      const worst = divergenceResult.hotspots[0];
      divergenceWarnEvent = {
        type: 'run-divergence',
        phaseName: worst?.phase ?? '(unknown)',
        key: worst?.key ?? '',
        repeats: divergenceResult.maxRepeats,
        threshold: divergenceResult.threshold,
        aborted: false,
        hotspots: divergenceResult.hotspots,
        ts: endedAt,
      };
    }
    if (!executorEmittedTerminal) {
      if (finalStatus === 'paused') {
        sentinel = {
          type: 'run-paused',
          pausedFor: pausedAt ?? 'unknown',
          ts: endedAt,
        };
      } else if (finalError) {
        sentinel = { type: 'run-error', error: finalError, ts: endedAt };
      } else if (finalStatus === 'cancelled') {
        // A CANCEL sentinel, not a generic `run-end`. The pre-aborted-signal
        // unwind above never builds the executor, so nothing yields the
        // executor's own `run-cancelled` — and `run-end` is what the A2A
        // mapper reports as a COMPLETED, final task, for a run whose row says
        // `cancelled`. It is also what the cancel seam's sentinel probe looks
        // for, so the generic shape earned the victim a second sentinel.
        sentinel = { type: 'run-cancelled', ts: endedAt };
      } else {
        sentinel = { type: 'run-end', status: finalStatus, ts: endedAt };
      }
    }
    terminalComputed = true;

    // Terminal writes are fenced too: if a peer reclaimed the run in the gap
    // after the last loop event (only possible with a very short TTL), these
    // throw LeaseLostError — yield quietly instead of crashing the background
    // task or stomping the new owner's rows.
    //
    // THEY ARE ALSO RETRIED, AND NO OTHER FAILURE ESCAPES. This block used to
    // rethrow any non-lease error BEFORE stopRenew / finished / active.delete /
    // the reap / onTerminal — and runInBackground is fire-and-forget, so one
    // SQLITE_BUSY, dropped connection or statement_timeout on the LAST write
    // left a lease-renewing zombie: row `running` forever and never reclaimable
    // (the heartbeat kept going), isActive true, cancel() a no-op, the group
    // held, the SSE stream never closed. Each append is done at most once
    // across attempts so a retry after a half-landed write cannot duplicate a
    // sentinel. If the write still fails, this leg tears itself down anyway:
    // stopping the heartbeat and leaving the active map is what lets the orphan
    // sweep — this process's own included, since the sweep spares an own row
    // only while a controller still drives it — reclaim the row as
    // `interrupted`: resumable, and the honest state for a run whose terminal
    // could not be recorded.
    let warnWritten = false;
    let sentinelWritten = false;
    for (let attempt = 1; ; attempt += 1) {
      try {
        if (divergenceWarnEvent && !warnWritten) {
          await store.appendEvent(id, divergenceWarnEvent);
          warnWritten = true;
        }
        if (sentinel && !sentinelWritten) {
          await store.appendEvent(id, sentinel);
          sentinelWritten = true;
        }
        // Both status writes below are FENCED (requireLease): they are the
        // executor-emitted terminal, and a de-leased leg must not stamp it
        // over the state the reclaiming peer is resuming from. An admin cancel
        // from another process stays unfenced — that is a different,
        // legitimate path.
        if (finalStatus === 'paused') {
          // Persist the wait index alongside the pause. `stateJson` is
          // replaced wholesale, so a lock-gate pause (pausedWait null) CLEARS
          // any stale pendingWait from an earlier wait leg — otherwise the
          // wait sweeper would "resume" a run that is actually parked at a
          // human gate.
          await store.updateRunStatus(
            id,
            {
              status: 'paused',
              pausedFor: pausedAt,
              stateJson: {
                leafOutputs,
                ...(resolvedInputs ? { resolvedInputs } : {}),
                ...(pausedWait ? { pendingWait: pausedWait } : {}),
              },
            },
            { requireLease: true },
          );
        } else {
          await store.updateRunStatus(
            id,
            {
              status: finalStatus,
              endedAt,
              // Persist the degradation verdict alongside the terminal
              // status. A clean `done` (or any non-`done`) writes false / []
              // — so a resume that ends clean clears a prior leg's
              // degradation too.
              degraded: degradation.degraded,
              degradationReasons: degradation.reasons,
            },
            { requireLease: true },
          );
        }
        break;
      } catch (termErr) {
        // A lost lease is final (a peer owns the row); exhausted attempts
        // are final; anything else is the transient the backoff exists for.
        if (termErr instanceof LeaseLostError) throw termErr;
        if (attempt >= TERMINAL_WRITE_ATTEMPTS) throw termErr;
        console.warn(
          `[run-controller] terminal write for ${id} failed (attempt ` +
            `${attempt}/${TERMINAL_WRITE_ATTEMPTS}, retrying):`,
          termErr instanceof Error ? termErr.message : termErr,
        );
        await new Promise<void>(r =>
          setTimeout(r, TERMINAL_WRITE_BACKOFF_MS * attempt),
        );
      }
    }
  } catch (termErr) {
    if (termErr instanceof LeaseLostError) {
      await yieldToPeer(
        `${termErr.message}; skipping terminal write for ${id}.`,
        finalStatus,
      );
      return;
    }
    terminalWriteError =
      termErr instanceof Error ? termErr.message : String(termErr);
    console.error(
      `[run-controller] run ${id} finished ${finalStatus} but its terminal ` +
        (terminalComputed
          ? `write FAILED after ${TERMINAL_WRITE_ATTEMPTS} attempts`
          : 'could not be DERIVED from its event log') +
        ' — the row still reads `running`. Stopping this leg\'s heartbeat so ' +
        'the orphan sweep (this process\'s own, or a peer\'s) can reclaim it ' +
        'as `interrupted` (resumable) once its lease lapses:',
      termErr,
    );
  }

  stopRenew();
  ctrl.finished = true;
  if (divergenceWarnEvent) deliver(divergenceWarnEvent);
  if (sentinel) deliver(sentinel);
  ctrl.listeners.clear();
  active.delete(id);

  // Reap orphaned grandchildren. The SDK's AbortController only kills the
  // direct `claude` subprocess; any process an agent spawned via a Bash tool
  // (headless Chrome, sim driver, hung shell loop) would otherwise orphan and
  // leak. Best-effort + awaited inside try/catch so a reap error can never
  // break run finalization. Only descendants of THIS server process spawned
  // DURING this run (not in the baseline) are touched — attributable + safe.
  await reapRunDescendants(id, finalStatus, ctrl.procBaseline);

  // Fire the terminal callback AFTER active.delete so the API layer's
  // error-orchestration handler can call startRun again without
  // colliding with this run's id. Fire-and-forget; throws inside the
  // callback are swallowed so the controller never crashes on a
  // buggy hook.
  if (onTerminal) {
    try {
      await onTerminal({
        id,
        status: finalStatus,
        error: finalError,
        degraded: degradation.degraded,
        degradationReasons: degradation.reasons,
        divergence: divergenceResult,
        notes,
        ...(terminalWriteError !== null ? { terminalWriteError } : {}),
      });
    } catch (hookErr) {
      console.error(
        `[run-controller] onTerminal hook for ${id} threw:`,
        hookErr,
      );
    }
  }
}

/** Reap processes this run spawned that outlived it. Best-effort: never
 *  throws (so it can't break run finalization), logs how many it killed.
 *  Scoped to descendants of THIS server process not present at run start —
 *  so other Claude Code sessions / unrelated apps (which are NOT descendants
 *  of this server) and pre-existing children are never touched. */
async function reapRunDescendants(
  id: string,
  status: RunStatus,
  baseline: Set<number>,
): Promise<void> {
  try {
    const { killed } = await reapNewDescendants(process.pid, baseline, {
      graceMs: 3000,
      runId: id,
      // This run has already left `active`; anyone still in it is live.
      otherRunsActive: [...active.keys()].some(k => k !== id),
    });
    if (killed.length > 0) {
      console.log(
        `[run-controller] reaped ${killed.length} orphaned descendant process(es) after ${id} ${status}`,
      );
    }
  } catch (reapErr) {
    console.warn(
      `[run-controller] descendant reap for ${id} failed (ignored):`,
      reapErr,
    );
  }
}

/** Belt-and-suspenders reap off an abort. The normal terminal path reaps when
 *  the executor loop unwinds after the abort, but if that loop is wedged (a
 *  hung Bash tool blocking the stream) it might not unwind promptly — so also
 *  reap directly off the abort, giving the SDK abort a moment to kill the
 *  direct claude subprocess first. Fire-and-forget + best-effort;
 *  reapNewDescendants is idempotent, so a double reap with the terminal path
 *  just no-ops on already-dead PIDs. Takes the baseline by value since the
 *  controller is removed from the active map once the run finalizes. Shared
 *  by cancel() and the renew tick's lease-loss handler so the two aborts can
 *  never differ in what they clean up. */
function scheduleAbortReap(
  id: string,
  status: RunStatus,
  baseline: Set<number>,
): void {
  const reapTimer = setTimeout(() => {
    void reapRunDescendants(id, status, baseline);
  }, ABORT_REAP_DELAY_MS);
  (reapTimer as unknown as { unref?: () => void }).unref?.();
}

/** Attach to a run's event stream. Sends history first, then live-tails
 *  for an in-flight run. Returns an unsubscribe fn the caller MUST
 *  invoke on client disconnect. */
export async function subscribe(
  store: RunStore,
  id: string,
  send: SendFn,
): Promise<{ unsubscribe: () => void; finished: boolean }> {
  const ctrl = active.get(id);
  if (ctrl && !ctrl.finished) {
    // Live run: the event mirror is authoritative. Snapshot + attach
    // synchronously — no store read, no async window, no race.
    for (const ev of ctrl.events) {
      try {
        send(ev);
      } catch {
        return { unsubscribe: () => {}, finished: true };
      }
    }
    ctrl.listeners.add(send);
    return {
      unsubscribe: () => ctrl.listeners.delete(send),
      finished: false,
    };
  }
  // Finished or unknown: replay from the store. The run is over, so no
  // new event can race in during the async read.
  const run = await store.getRun(id);
  if (!run) {
    send({ type: 'run-error', error: `Unknown run id: ${id}` });
    return { unsubscribe: () => {}, finished: true };
  }
  for (const ev of run.events) {
    try {
      send(ev);
    } catch {
      return { unsubscribe: () => {}, finished: true };
    }
  }
  return { unsubscribe: () => {}, finished: true };
}

export type ResumeOpts = {
  store: RunStore;
  id: string;
  /** Builder that — given the AbortSignal, replayOutputs map,
   *  autoApproveLocks set, and gateMessages map — returns the
   *  executor's event source. `gateMessages` carries a human's
   *  free-text gate correction (phase name → instruction) so the gated
   *  phase's agent receives it; empty for a plain (message-less)
   *  resume. */
  buildEventSource: (
    signal: AbortSignal,
    replayOutputs: Record<string, string>,
    autoApproveLocks: string[],
    gateMessages: Record<string, string>,
    runId: string,
    /** Durable-wait seed for the resumed leg (see wait-resolution.ts):
     *  unresolved `wait` specs (so a re-crossed wait honors its ORIGINAL
     *  deadline) + buffered, unconsumed signal payloads. Derived here from
     *  the run's events; thread both into runOrchestration
     *  (`pendingWaits` / `deliveredSignals`). */
    waits: WaitSeed,
    /** The run's resolved declared inputs, from its checkpoint — pass them
     *  on as `resolvedInputs` so `${name}` resolves in the resumed leg. */
    resolvedInputs: Record<string, string> | undefined,
  ) => AsyncIterable<StoredEvent>;
  /** Optional human gate correction to wire into the gated phase. Keyed
   *  by phase name (typically the run's `pausedFor`). Threaded to
   *  buildEventSource's gateMessages arg — with one refinement: on an
   *  approve-path resume (`reArmLock` unset) an entry keyed by the bare
   *  `pausedFor` is RE-KEYED to the paused gate's iteration-scoped key
   *  (the last lock-gate event's `replayKey`) when one was recorded, so
   *  the executor delivers the message to exactly the gated ITERATION —
   *  a bare name under a map/loop could be consumed by the wrong
   *  same-named phase. Other keys pass through untouched (the
   *  request-changes path targets a different phase by display name and
   *  relies on the executor's bare-name fallback). Absent for a plain
   *  resume. */
  gateMessages?: Record<string, string>;
  /** Optional replay-cache invalidation. Each entry is a leaf's `replayKey`
   *  (equal to its phase name for unscoped leaves; scoped for loop/map
   *  iterations) whose cached output should be DROPPED before resume — so
   *  that leaf re-executes instead of replaying its stale output. Used by
   *  the 'request-changes' gate decision to force the reviewed plan's
   *  producing phase to re-run with the human's feedback. Excluded from
   *  BOTH the executor's replayOutputs map AND the resume seed's
   *  completedLeaves/leafOutputs, so the re-run re-checkpoints cleanly.
   *  Everything NOT listed still replays from cache (no wasted re-work). */
  invalidateLeaves?: string[];
  /** When true, do NOT auto-approve the lock the run paused at — so the
   *  gate fires again and the run RE-PAUSES at the same phase after the
   *  re-run. The default (false) auto-approves `pausedFor` exactly like a
   *  plain resume / approve, letting the run proceed THROUGH the gate. Set
   *  by the 'request-changes' decision, whose whole point is a review loop:
   *  re-run the reviewed phase, then pause again so the human sees the
   *  revision before it proceeds. */
  reArmLock?: boolean;
  /** Server-side spend gate for the RESUMED leg. Resume used to drop this
   *  (only fresh starts got one), so a run's post-pause spending escaped
   *  the daily/monthly caps entirely. Same semantics as startRun's:
   *  mid-flight halt when the leg's cost crosses the cap. */
  budgetGate?: BudgetGate;
  /** Terminal hook for the resumed leg. Resume used to drop this too, so
   *  ANY run that paused (gate or wait) and then finished via resume
   *  skipped everything the hook owns: `<orch>.done`/`.error` event
   *  publishing (reactive chains), notify.onTerminal, the
   *  lifecycle.errorOrchestration recovery, the cron circuit-breaker,
   *  the OTLP push, and the concurrency-group drain of parked fires.
   *  Callers should pass the SAME hook the start path builds. */
  onTerminal?: (info: TerminalInfo) => void | Promise<void>;
  /** Run-level divergence (retry-storm) watchdog config for the resumed
   *  leg — the orchestration root's `notify.divergence`, same as start. */
  divergence?: DivergenceConfig;
};

export type ResumeResult = { ok: true } | { ok: false; reason: string };

/** Resume a paused — or boot-time `interrupted` — run: replay completed
 *  leaves, re-execute from the cut point. Same run id, more events.
 *  Interrupted runs have `pausedFor=null`, so `autoApproveLocks` is empty
 *  (nothing to skip) and the executor picks up at the phase that was
 *  in flight when the previous process died. */
export async function resume(opts: ResumeOpts): Promise<ResumeResult> {
  const run = await opts.store.getRun(opts.id);
  if (!run) return { ok: false, reason: `Unknown run id: ${opts.id}` };
  if (
    run.status !== 'paused' &&
    run.status !== 'interrupted' &&
    run.status !== 'error'
  ) {
    return {
      ok: false,
      reason: `Run is ${run.status}, not paused/interrupted/error — nothing to resume.`,
    };
  }
  // Resume-from-error: a run that died AFTER completing a 30–70-minute phase
  // used to repay full price on restart even though `completedLeaves` +
  // leafOutputs were sitting in the store. An `error` (or `interrupted`)
  // terminal RELEASED its concurrency
  // group (the terminal drain), so unlike a paused run it no longer holds
  // its slot — re-check the group before re-walking, or the resumed leg
  // would overlap whatever run the drain admitted. Semantics an operator
  // should know: the original terminal already fired its `<orch>.error`
  // event / errorOrchestration; resuming does not rewind those.
  //
  // The re-check happens INSIDE the claim below, under the group's
  // store-backed lock — the same lock the start-gate takes. A plain read here
  // let two interrupted runs of one `queue` group, resumed together, both see
  // an empty group and both run; and a fresh start landing between this read
  // and the claim did the same. Resumable rows from a group hold no slot, so
  // only the lock makes "the group is free" true at the moment of the flip.
  const resumeGroup =
    (run.status === 'error' || run.status === 'interrupted') &&
    run.concurrencyGroup
      ? run.concurrencyGroup
      : null;
  const state =
    (run.stateJson as {
      leafOutputs?: Record<string, string>;
      resolvedInputs?: Record<string, string>;
    } | null) ?? {};
  // Apply replay-cache invalidation: drop the named leaves from the
  // replay set so they re-execute. The gate handler uses this for
  // 'request-changes' to re-run the reviewed plan's producing phase with
  // the human's feedback while every OTHER completed leaf still replays
  // from cache (so upstream work is never redone). When the run is paused
  // at a `lock`, the gate fires BEFORE the gated phase dispatches — so
  // nothing downstream of the gate has executed yet, and there is nothing
  // downstream to invalidate; only the already-completed reviewed leaf is.
  const invalidate = new Set(opts.invalidateLeaves ?? []);
  const allLeafOutputs = state.leafOutputs ?? {};
  const replayOutputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(allLeafOutputs)) {
    if (!invalidate.has(key)) replayOutputs[key] = value;
  }
  const seedCompletedLeaves = (run.completedLeaves ?? []).filter(
    k => !invalidate.has(k),
  );
  const pausedFor = run.pausedFor;
  // The current gate's iteration-SCOPED key. `pausedFor` is the bare display
  // name (unchanged — keeps the UI + gateMessages keying intact); the gate's
  // per-iteration identity lives on its `lock-gate` event's `replayKey`. The
  // LAST lock-gate is the gate the run paused at, so its replayKey is the
  // current gate's scoped key (e.g. `<map>[1]/implement-and-qa`). Falls back to
  // the bare `pausedFor` when there's no lock-gate event carrying a replayKey
  // (a top-level gate, or a legacy run recorded before lock-gate carried it).
  // Null for `interrupted` runs (no gate).
  let currentGateKey: string | null = pausedFor;
  if (pausedFor) {
    for (let i = run.events.length - 1; i >= 0; i--) {
      const e = run.events[i] as { type?: string; replayKey?: string };
      if (e.type === 'lock-gate') {
        if (typeof e.replayKey === 'string') currentGateKey = e.replayKey;
        break;
      }
    }
  }
  // Auto-approve the gated lock so the run proceeds THROUGH it — unless
  // reArmLock is set (request-changes), in which case we leave it armed so
  // the gate fires again and the run re-pauses after re-running the
  // reviewed phase. (`interrupted` runs have pausedFor=null → empty set.)
  //
  // SCOPE: seed the CURRENT gate's scoped key. The executor CONSUMES an
  // auto-approve entry on its first matching gate hit (scoped key first,
  // bare-name fallback), so this covers only the iteration that paused: a LATER
  // iteration of the same gated phase (inside a serial map / refinement loop)
  // has a different scoped key, finds nothing, and re-gates instead of being
  // silently skipped. Keying by the scoped key (not the bare name) is also what
  // stops the earlier iterations' already-crossed gates — see priorLocks — from
  // colliding with this one and consuming its bare-name entry on the re-walk
  // (the serial-map resume→re-pause loop the 2nd item could never escape).
  //
  // PRIOR GATES: resuming re-walks the tree from the top, so EVERY earlier
  // `lock` the run already crossed (in a prior pass) would re-fire its gate
  // and re-pause the run there — never reaching the work the human acted on.
  // A multi-gate flow (ticket-to-PR has two: the plan gate `implement-and-qa`
  // and the ship gate `open-pr`) would otherwise bounce between gates forever
  // — the exact mechanism behind a request-changes at the ship gate looping
  // back and never reaching it. And a per-iteration gate inside a serial `map`
  // crosses the SAME-named gate once per already-done item. So auto-approve
  // every already-crossed lock — by its SCOPED key, derived from the durable
  // `lock-gate` events — in addition to the current gate (unless reArmLock
  // leaves it armed). Each is consumed once on its single re-walk crossing.
  // Exclude the current gate's scoped key so it isn't listed twice.
  const priorLocks = priorCrossedLocks(run.events, currentGateKey);
  const autoApproveLocks = [
    ...priorLocks,
    ...(currentGateKey && !opts.reArmLock ? [currentGateKey] : []),
  ];

  // CLAIM the run, don't check-then-act. The status guard at the top was a
  // read; two concurrent resumes (an operator click racing the wait sweeper,
  // or two replicas) both passed it, both flipped the row and both started an
  // executor for one run id. The precondition is now IN the UPDATE: only a
  // resumable row flips, and the loser of the race sees zero rows.
  const resumedEvent: StoredEvent = {
    type: 'run-resumed',
    pausedFor: pausedFor ?? 'unknown',
    ts: Date.now(),
  };
  const claim = async (): Promise<ResumeResult | null> => {
    if (resumeGroup) {
      const active = await opts.store.findActiveRunsInGroup(resumeGroup);
      const blocker = active.find(r => r.id !== run.id);
      if (blocker) {
        return {
          ok: false,
          reason:
            `Concurrency group "${resumeGroup}" is busy (run ` +
            `${blocker.id}) — this ${run.status} run released the group at ` +
            `its terminal. Retry once the group is free.`,
        };
      }
    }
    const claimed = await opts.store.updateRunStatus(
      opts.id,
      {
        status: 'running',
        pausedFor: null,
        endedAt: null,
      },
      { onlyIfStatus: ['paused', 'interrupted', 'error'] },
    );
    if (!claimed) {
      return {
        ok: false,
        reason:
          `Run ${opts.id} was resumed (or changed state) by another caller ` +
          'between the status check and the claim — nothing to resume.',
      };
    }
    await opts.store.appendEvent(opts.id, resumedEvent);
    return null;
  };
  // A group-released row takes the group's lock for the whole read → flip →
  // append, so the gate (and any other resume) sees the row `running` before
  // it can decide. Every other resumable row already holds its slot, or has
  // none, and claims directly.
  const refused = resumeGroup
    ? await resumeGroupLockFor(opts.store).run(resumeGroup, claim)
    : await claim();
  if (refused) return refused;

  const ctrl: ActiveRun = {
    id: opts.id,
    abortController: new AbortController(),
    listeners: new Set(),
    // Seed the mirror with the pre-resume history so a subscriber that
    // attaches after resume still replays the full run.
    events: [...run.events, resumedEvent],
    finished: false,
    // Re-baseline the descendant tree for this resumed leg.
    procBaseline: descendantPids(process.pid),
  };
  active.set(opts.id, ctrl);

  // STORE-THEN-LOAD against the cancel seam's flip-then-isActive. The claim
  // above published the row `running` before this registration, and a cancel
  // landing in that gap flipped it, found no local controller to abort,
  // appended its sentinel and drained the group — then this leg started
  // anyway, with a signal nobody had aborted, against the cancelled row. One
  // side must now observe the other: either the cancel finds the controller
  // and aborts it (the live path), or this re-read finds the flip and never
  // starts. Registering before the claim instead would expose a run that may
  // never resume (the group-lock wait, a refused claim) to subscribers.
  //
  // WRAPPED like startRun's insert, and for a sharper reason. This is the only
  // await between the registration above and `void runInBackground` below, and
  // runInBackground is the sole owner of the teardown — so a throw here (a
  // dropped connection, a statement timeout, SQLITE_BUSY) leaves the
  // controller in `active` for the life of the process. The row is already
  // published `running` with a fresh lease and nothing renews it, and the
  // orphan sweep spares an OWN row exactly while a controller still drives it:
  // the leak is what makes the row permanently unreclaimable, in the
  // single-process topology that reclaim was written for. The claim is NOT
  // undone here — a compensating write would race a cancel's CAS flip; with
  // the map entry gone the sweep reclaims the row as `interrupted` one lease
  // TTL later, the same recovery the failed-terminal-write case uses.
  let claimedRow: RunSummary | null;
  try {
    claimedRow = await opts.store.getRunSummary(opts.id);
  } catch (err) {
    ctrl.finished = true;
    active.delete(opts.id);
    throw err;
  }
  if (claimedRow?.status !== 'running') {
    ctrl.finished = true;
    active.delete(opts.id);
    return {
      ok: false,
      reason:
        `Run ${opts.id} was ${claimedRow?.status ?? 'deleted'} while ` +
        'resuming — nothing to resume.',
    };
  }

  // Scope the approve-path gate message to the CURRENT gate instance. The
  // API's approve handler keys the human's message by the bare `pausedFor`
  // (all it knows), but the executor consumes gateMessages scoped-key-FIRST
  // (see ExecutorContext.gateMessages): under a map/loop the bare name is
  // ambiguous — a same-named phase from a DIFFERENT iteration could consume
  // the message meant for the paused gate. We already derived the paused
  // gate's scoped identity above (`currentGateKey`, from its lock-gate
  // event), so move the entry onto it. Only on the approve path
  // (`!reArmLock`): a request-changes message targets the feedback phase —
  // not the gate — by display name, and must keep the bare-name fallback.
  // No-op when the gate is unscoped (currentGateKey === pausedFor) or when
  // no message was supplied; pause/store semantics are untouched.
  const gateMessages = { ...(opts.gateMessages ?? {}) };
  if (
    !opts.reArmLock &&
    pausedFor &&
    currentGateKey &&
    currentGateKey !== pausedFor &&
    typeof gateMessages[pausedFor] === 'string'
  ) {
    gateMessages[currentGateKey] = gateMessages[pausedFor];
    delete gateMessages[pausedFor];
  }
  // Durable-wait seed for the re-walk. Derived from the SAME event stream
  // the lock auto-approve set comes from: unresolved wait-started specs (a
  // re-crossed `wait` re-parks against its original deadline — or completes,
  // when it's now due) + unconsumed signal-received payloads (a buffered
  // signal resolves its wait on the re-cross). Uses the UN-invalidated leaf
  // map for completion detection: request-changes invalidation re-runs a
  // reviewed phase, it doesn't un-happen a wait.
  const waitSeed = deriveWaitState(run.events, allLeafOutputs);

  void runInBackground(
    opts.store,
    opts.id,
    (signal, runId) =>
      opts.buildEventSource(
        signal,
        replayOutputs,
        autoApproveLocks,
        gateMessages,
        runId,
        waitSeed,
        state.resolvedInputs,
      ),
    ctrl,
    opts.budgetGate,
    {
      completedLeaves: seedCompletedLeaves,
      leafOutputs: { ...replayOutputs },
      lastOutput: run.lastOutput,
      resolvedInputs: state.resolvedInputs,
    },
    opts.onTerminal,
    opts.divergence,
  );

  return { ok: true };
}

/** Abort a running run. True if a controller was told to abort. */
export function cancel(id: string): boolean {
  const ctrl = active.get(id);
  if (!ctrl || ctrl.finished) return false;
  ctrl.abortController.abort();
  scheduleAbortReap(id, 'cancelled', ctrl.procBaseline);
  return true;
}

/** Are we still running this id? */
export function isActive(id: string): boolean {
  const ctrl = active.get(id);
  return !!ctrl && !ctrl.finished;
}

/** Register / clear an A2A push-notification webhook for a live run.
 *  In-memory only — wiped when the run leaves the active map. Returns
 *  true if the run was active and the config was applied. */
export function setPushNotification(
  id: string,
  url: string | null,
): boolean {
  const ctrl = active.get(id);
  if (!ctrl || ctrl.finished) return false;
  ctrl.pushUrl = url ?? undefined;
  return true;
}

/** Read the current push URL for a live run (A2A tasks/pushNotificationConfig/get). */
export function getPushNotification(id: string): string | undefined {
  return active.get(id)?.pushUrl;
}


/** Test hook — drain in-memory state so each test starts fresh. */
export function _resetForTests(): void {
  for (const ctrl of active.values()) {
    try {
      ctrl.abortController.abort();
    } catch {
      /* ignore */
    }
  }
  active.clear();
}
