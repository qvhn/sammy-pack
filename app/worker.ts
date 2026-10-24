/**
 * Standalone delivery worker (P6 → executor-in-worker) — drains the durable
 * trigger-delivery queue as its own process, with two execution modes:
 *
 *   - direct (default): builds AND executes the run in THIS process via the
 *     extracted run engine (run-context.ts + run-runner.ts), with the SAME
 *     guarantees as the server — budget caps (pre-run + mid-flight), reactive
 *     eventing (`<orch>.done` chains via worker-terminal-hook.ts), and
 *     errorOrchestration recovery. No server needed; the horizontal-scale +
 *     durability unlock. Run several against one Postgres (claim safety is the
 *     store's FOR UPDATE SKIP LOCKED).
 *   - delegate (set SAMMY_SERVER_URL): POSTs /api/runs/start to a running
 *     server, which owns execution. Use when you'd rather centralize it.
 *
 *   DATABASE_URL=postgres://sammy:sammy@localhost:5433/sammy npm run worker
 *   SAMMY_SERVER_URL=http://localhost:5173 npm run worker   # delegate mode
 *
 * Env: SAMMY_WORKER_CONCURRENCY, SAMMY_MAX_INFLIGHT_PER_ORCH, SAMMY_API_TOKEN
 * (delegate auth), SAMMY_REPO_ROOT (SQLite path; default ..).
 *
 * The direct-mode gate (`makeDirectRunDelivery`) and the orphan scan
 * (`scanOrphanedRuns`) are exported so their concurrency behaviour is testable
 * against a store; `main()` runs only when this file is the entry point.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openRunStore, type RunStore } from './src/server/run-store';
import {
  DeliveryWorker,
  type RunDeliveryFn,
  type RunDeliveryResult,
} from './src/server/delivery-worker';
import { makeLoadRunContext } from './src/server/run-context';
import { artifactLoaderFor, createRunRunner } from './src/server/run-runner';
import {
  startRun as startServerRun,
  cancel as cancelServerRun,
  isActive as isActiveServerRun,
} from './src/server/run-controller';
import { loadBudgetState } from './src/server/budget-store';
import {
  drainPendingFireToQueue,
  makeWorkerTerminalHook,
} from './src/server/worker-terminal-hook';
import { envPositiveInt } from './src/server/env';
import { DEFAULT_LEASE_TTL_MS } from './src/server/run-store';
import {
  DurableGroupLock,
  decideConcurrency,
  effectiveConcurrency,
} from './src/server/concurrency-group';
import {
  admitDelivery,
  BUDGET_RECHECK_MS,
  IntakePauseStore,
  isScheduleKind,
} from './src/server/admission';

const root = process.env.SAMMY_REPO_ROOT || path.resolve(process.cwd(), '..');
let deliverySeq = 0;
const newDeliveryId = () =>
  `del-${Date.now()}-${(deliverySeq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const serverUrl = process.env.SAMMY_SERVER_URL?.trim();
const token = process.env.SAMMY_API_TOKEN?.trim();
/** Delegate-mode run-creation timeout. See the fetch call for why it is not
 *  optional. */
const httpTimeoutMs = Math.max(
  1_000,
  Number(process.env.SAMMY_WORKER_HTTP_TIMEOUT_MS) || 30_000,
);
/** How long cancel-existing waits for a LOCAL victim's executor to leave the
 *  active map after the abort — the server seam's bound, mirrored. */
const LOCAL_UNWIND_BOUND_MS = 5_000;

export type DirectRunDeliveryOpts = {
  store: RunStore;
  /** Workspace root — `examples/`, `agents/` and `budget.json` live under it. */
  root: string;
  newDeliveryId: () => string;
};

/** Direct mode: load the orchestration context + build the executor here,
 *  exactly as the server does, and run it via the run-controller. */
export function makeDirectRunDelivery(opts: DirectRunDeliveryOpts): RunDeliveryFn {
  const { store } = opts;
  const examplesDir = path.join(opts.root, 'examples');
  const budgetFile = path.join(opts.root, 'budget.json');
  const intakePauses = new IntakePauseStore(opts.root);
  /** Per-group mutex making the direct-mode start-gate's check-and-create
   *  atomic, exactly as the server's does — and CROSS-PROCESS, which matters
   *  most here: running several workers against one Postgres is the whole
   *  point of this process, and an in-memory lock cannot serialize them. */
  const groupLock = new DurableGroupLock(store, {
    holder: `worker-${process.pid}-${randomUUID().slice(0, 8)}`,
    log: m => console.warn(`[worker] concurrency: ${m}`),
  });

  const loadRunContext = makeLoadRunContext({
    examplesDir,
    agentsDir: path.join(opts.root, 'agents'),
  });
  const runner = createRunRunner({ root: opts.root, loadArtifact: artifactLoaderFor(store) });

  // Recovery dispatcher for lifecycle.errorOrchestration (the worker owns the
  // run engine, so it can start the recovery run itself). The recovery run
  // carries the SAME guarantees as a normal run — the budget gate (mid-flight
  // cap) + a terminal hook so its own events fire — except it does NOT cascade
  // recovery (startRecoveryRun is omitted from its hook), matching the server's
  // "failures don't cascade" rule so an erroring recovery can't loop.
  const startRecoveryRun = async (
    recoveryName: string,
    envelope: string,
    owner: string,
  ): Promise<void> => {
    const ctx = await loadRunContext(recoveryName);
    if (!ctx) return;
    // Owner-scoped, like the server's fireRun: without the owner the cap is
    // workspace-global on exactly the topology this process exists for.
    const { gate } = await loadBudgetState(budgetFile, store, owner);
    await startServerRun({
      store,
      orchestrationName: recoveryName,
      initialInput: envelope,
      orchestrationSnapshot: ctx.orchestration,
      budgetGate: gate,
      ownerId: owner,
      onTerminal: makeWorkerTerminalHook({
        orchName: recoveryName,
        orch: ctx.orchestration,
        ownerId: owner,
        store,
        examplesDir,
        root: opts.root,
        newDeliveryId: opts.newDeliveryId,
        // no startRecoveryRun → recovery does not cascade (loop-safe)
      }),
      buildEventSource: (signal, runId) =>
        runner.buildExecutorSource(
          ctx,
          { initialInput: envelope, allowAgentTools: true, ownerId: owner, runId },
          signal,
        ),
    });
  };

  /** Stop a run that holds the group, through the STORE, so the row reads
   *  `cancelled` before the gate re-decides — and abort it locally too when
   *  it is ours, so it stops now rather than at its next renew tick.
   *
   *  `cancelServerRun` only aborts a controller in THIS process, so in the
   *  multi-process topology it was a silent no-op against a peer's run and
   *  the new run started alongside it — both executing against the resource
   *  the group exists to serialise. The store flip is what stops a peer's
   *  run (its lease renewal sees it is no longer `running` and aborts); for
   *  our own run it also fences the victim's terminal, which therefore
   *  cannot drain the group — so release the parked fire here, as the
   *  server's cancelStoredRunAndDrain does. The fire re-enters through the
   *  queue, never inline, so no lock is re-entered. */
  const cancelExistingRun = async (id: string, group: string): Promise<void> => {
    const existing = await store.getRun(id);
    const terminal =
      existing?.status === 'done' ||
      existing?.status === 'error' ||
      existing?.status === 'cancelled';
    if (!existing || terminal) return;
    await store.updateRunStatus(id, {
      status: 'cancelled',
      endedAt: Date.now(),
    });
    // Who owns the victim's `run-cancelled`. A LOCAL victim's unwind yields
    // its own, which the controller persists (the append fence only guards
    // `running` rows), so this path appends only when no local victim will
    // write one. Appending unconditionally recorded TWO for one victim, and
    // each sentinel becomes its own A2A `canceled` FINAL status update.
    let victimWritesSentinel = false;
    const local = cancelServerRun(id);
    if (local) {
      // The abort reaches the executor at its next checkpoint, not now. The
      // server's seam waits for the unwind before the new run exists; this
      // one returned at once, so the gate re-decided — and inserted the new
      // run — while the victim's agent subprocesses were still alive. Wait,
      // bounded; past the bound proceed loudly, the row is already
      // `cancelled` so the victim's next fenced write stops it.
      const deadline = Date.now() + LOCAL_UNWIND_BOUND_MS;
      while (isActiveServerRun(id) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 25));
      }
      if (isActiveServerRun(id)) {
        console.warn(
          `[worker] cancel-existing: ${id} had not unwound within ` +
            `${LOCAL_UNWIND_BOUND_MS}ms — proceeding; its own ` +
            'run-cancelled lands when it does',
        );
        // Past the bound the victim is STILL EXECUTING, so its sentinel is
        // still to come rather than absent — the bound exists for exactly
        // that case (a leg wedged on an in-flight tool call), which is why
        // reading "no sentinel yet" as "none will land" produced the
        // duplicate deterministically, not rarely.
        victimWritesSentinel = true;
      } else {
        // Same rule as the server seam: one sentinel, the victim's own if it
        // wrote one. The bounded wait is what makes this a decision rather
        // than a race — it guarantees the victim's own has landed.
        victimWritesSentinel =
          (await store.getRun(id))?.events.some(
            e => e.type === 'run-cancelled',
          ) ?? false;
      }
    }
    if (!victimWritesSentinel) {
      await store.appendEvent(id, { type: 'run-cancelled', ts: Date.now() });
    }
    await drainPendingFireToQueue(store, group, opts.newDeliveryId);
    console.log(
      `[worker] cancel-existing: stopped ${local ? 'local' : 'peer-owned'} ${id} via the store`,
    );
  };

  const runDirect: RunDeliveryFn = async d => {
    const ctx = await loadRunContext(d.orchestrationName);
    if (!ctx) {
      return {
        ok: false,
        error: `orchestration "${d.orchestrationName}" not in workspace`,
        retryable: false,
      };
    }
    // Per-orchestration admission (intake pause + root `limits`), identical
    // to the server's and in the server's ORDER — admission, then budget. A
    // drained fire was admitted when first delivered.
    if (d.kind !== 'concurrency-drain') {
      const verdict = await admitDelivery({
        store,
        pauses: intakePauses,
        orchestrationName: d.orchestrationName,
        limits: ctx.orchestration.limits,
        kind: d.kind,
        now: Date.now(),
      });
      if (verdict.action === 'hold') {
        return { ok: false, hold: true, until: verdict.until, detail: verdict.reason };
      }
      if (verdict.action === 'refuse') {
        return { ok: false, error: verdict.reason, retryable: false };
      }
    }
    // Budget enforcement — mirror the server's fireRun, and hand the gate to
    // the controller for the mid-run halt. (Without this, a direct-mode worker
    // would run with no cap.) Scoped to the delivery's owner, as the server
    // scopes it, so one team's runaway sweep cannot refuse every other team's
    // runs.
    const { status: bs, gate } = await loadBudgetState(budgetFile, store, d.ownerId);
    if (bs.blocked) {
      // HELD, not refused: a spent budget clears on its own (the day rolls
      // over, or the cap is raised), so the fire waits rather than landing in
      // the dead-letter view. A scheduled tick is skipped instead (see
      // isScheduleKind).
      if (isScheduleKind(d.kind)) {
        return {
          ok: false,
          error: 'budget cap reached — scheduled tick skipped',
          retryable: false,
        };
      }
      return {
        ok: false,
        hold: true,
        until: Date.now() + BUDGET_RECHECK_MS,
        detail: 'budget cap reached — deferring, not dropping',
      };
    }
    const startOpts = {
      store,
      orchestrationName: d.orchestrationName,
      initialInput: d.body ?? '',
      orchestrationSnapshot: ctx.orchestration,
      budgetGate: gate,
      ownerId: d.ownerId,
      divergence: ctx.orchestration.notify?.divergence,
      // Reactive eventing (<orch>.done chains) + errorOrchestration recovery,
      // run against the store + workspace — direct mode is now a true peer.
      onTerminal: makeWorkerTerminalHook({
        orchName: d.orchestrationName,
        orch: ctx.orchestration,
        ownerId: d.ownerId,
        store,
        examplesDir,
        root: opts.root,
        newDeliveryId: opts.newDeliveryId,
        startRecoveryRun,
      }),
      buildEventSource: (signal: AbortSignal, runId: string) =>
        runner.buildExecutorSource(
          ctx,
          {
            initialInput: d.body ?? '',
            allowAgentTools: true,
            ownerId: d.ownerId,
            runId,
          },
          signal,
        ),
    };

    // THE CONCURRENCY START-GATE. This used to call startServerRun directly,
    // bypassing it entirely — so in a worker-only deployment
    // (SAMMY_DISABLE_INPROCESS_WORKER=1 + `npm run worker`) a
    // `concurrency: { group }` declaration was silently NOT ENFORCED, and
    // because the run header carried no group, parked fires for that group
    // never drained either. Same decision function as the server's gate, so
    // the two cannot diverge.
    // Same effective group the server computes, including the implicit
    // per-orchestration cron group — so a cron cannot overlap itself here
    // either, and the two code paths cannot drift.
    // A drain re-queued as a delivery may run long after its group was
    // released; if another run holds the group by now, park behind it (the
    // server does the same — before, a budget-held drain for an implicit
    // `sammy:cron:<orch>` group started ungated and overlapped the holder).
    if (d.kind === 'concurrency-drain' && d.name) {
      const busy = await store.findActiveRunsInGroup(d.name);
      if (busy.length > 0) {
        await store.enqueuePendingFire(d.name, {
          orchName: d.orchestrationName,
          initialInput: d.body ?? '',
          ownerId: d.ownerId,
        });
        if ((await store.findActiveRunsInGroup(d.name)).length === 0) {
          await drainPendingFireToQueue(store, d.name, opts.newDeliveryId);
        }
        return {
          ok: false,
          deferred: true,
          detail: `concurrency: re-parked behind ${busy[0].id} in group ${d.name}`,
        };
      }
    }
    const conc = effectiveConcurrency(ctx.orchestration, d.kind, d.body ?? '', ref =>
      console.warn(
        `[worker] concurrency: ${d.orchestrationName}: group ref \${${ref}} did not ` +
          'resolve from the input — the fire joins the unresolved literal group (serialized)',
      ),
    );
    if (!conc) {
      try {
        const { id } = await startServerRun({
          ...startOpts,
          // The group a DRAINED fire was parked under — carried on the
          // delivery's `name` by `drainPendingFireToQueue`. The kind
          // `concurrency-drain` ungates the fire on purpose (the group was
          // just released), but creating the run with NO group also made it
          // invisible as a holder: its own terminal read a null group and
          // drained nothing, so an implicit `sammy:cron:<name>` backlog
          // advanced by at most one fire per later cron tick and stopped
          // advancing entirely once ticks ceased (trigger edited away,
          // orchestration deleted, breaker auto-pause) — `/api/concurrency`
          // reporting `held: false` beside a non-empty `queued`. Stamping it
          // leaves the gate's decision untouched and makes the drained run a
          // real holder, as the server's `knownGroup` does.
          concurrencyGroup:
            d.kind === 'concurrency-drain' ? d.name || null : null,
        });
        return { ok: true, runId: id };
      } catch (e) {
        return { ok: false, error: (e as Error).message, retryable: true };
      }
    }
    const { group, policy } = conc;
    try {
      // The gate is SHORT critical sections with any cancel BETWEEN them,
      // never one long one that cancels from inside the lock — the server's
      // shape. The cancel-existing branch used to run its cancels INSIDE
      // `groupLock.run(group)` and did not wait for the victim's row to
      // flip, so the new run was created while the old one still held the
      // group (and, locally, while its agent subprocesses were still alive).
      // Now: under the lock, only DECIDE and record the ids to cancel;
      // release; cancel through the store outside; re-enter the lock to
      // start, re-deciding because state has moved. Bounded: after
      // CANCEL_EXISTING_PASSES the run starts anyway, loudly, per the
      // fail-open rule below.
      const CANCEL_EXISTING_PASSES = 3;
      for (let pass = 0; ; pass += 1) {
        const decided = await groupLock.run(
          group,
          async (): Promise<RunDeliveryResult | { cancelIds: string[] }> => {
            const active = await store.findActiveRunsInGroup(group);
            const decision = decideConcurrency(policy, active);
            if (decision.action === 'skip') {
              return {
                ok: false as const,
                error: `concurrency: group ${group} busy (${decision.blockingId}) — skipped by policy`,
                retryable: false,
              };
            }
            if (decision.action === 'queue') {
              await store.enqueuePendingFire(group, {
                orchName: d.orchestrationName,
                initialInput: d.body ?? '',
                ownerId: d.ownerId,
              });
              // Parked, not refused — the delivery is terminal but NOT a dead
              // letter, so it stays out of the replay view.
              return {
                ok: false as const,
                deferred: true as const,
                detail: `concurrency: parked behind ${decision.blockingId} in group ${group}`,
              };
            }
            if (decision.action === 'cancel-existing') {
              if (pass < CANCEL_EXISTING_PASSES) {
                return { cancelIds: decision.cancelIds };
              }
              console.warn(
                `[worker] concurrency: cancel-existing for ${d.orchestrationName} ` +
                  `(group ${group}): ${decision.cancelIds.join(', ')} still active ` +
                  `after ${pass} cancel passes — starting anyway`,
              );
            }
            const { id } = await startServerRun({ ...startOpts, concurrencyGroup: group });
            return { ok: true as const, runId: id };
          },
        );
        if (!('cancelIds' in decided)) return decided;
        // OUTSIDE the lock, awaited: the re-entered gate must see the
        // victims' rows already flipped.
        for (const id of decided.cancelIds) {
          try {
            await cancelExistingRun(id, group);
          } catch (err) {
            console.error(`[worker] cancel of ${id} failed (continuing):`, err);
          }
        }
      }
    } catch (e) {
      // The gate must never break the start path — mirror the server: start
      // anyway, still stamping the group so the terminal drain stays coherent.
      console.error(`[worker] concurrency gate for ${group} failed; starting anyway:`, e);
      try {
        const { id } = await startServerRun({ ...startOpts, concurrencyGroup: group });
        return { ok: true, runId: id };
      } catch (err) {
        return { ok: false, error: (err as Error).message, retryable: true };
      }
    }
  };

  // A `limits` cap is exact only if counting today's runs and creating the
  // run are one step; this worker claims several deliveries at once, so
  // serialize them per orchestration when it declares limits (same as the
  // server's admissionLock).
  const runDirectAdmitted: RunDeliveryFn = async d => {
    if (d.kind !== 'concurrency-drain') {
      // Only the orchestration's own file — loadRunContext walks the whole
      // workspace, and runDirect loads it once anyway.
      let limits: unknown;
      try {
        const raw = JSON.parse(
          await fs.readFile(path.join(examplesDir, `${path.basename(d.orchestrationName)}.json`), 'utf8'),
        ) as { limits?: unknown };
        limits = raw?.limits;
      } catch {
        limits = undefined;
      }
      if (limits) {
        // Store-backed: also serializes against the server's admission.
        return groupLock.run(`sammy:admit:${d.orchestrationName}`, () => runDirect(d));
      }
    }
    return runDirect(d);
  };
  return runDirectAdmitted;
}

/** Reclaim orphaned RUNS too, not just deliveries. The server does this on
 *  boot; the worker did not, so a worker-only deployment left every run that
 *  was executing at crash time stuck `running` forever — invisible to the
 *  resume sweeper and counted against concurrency groups and in-flight caps
 *  by rows that will never terminate.
 *
 *  A reclaimed run released its group (interrupted is not active) without
 *  ever reaching a terminal hook, so its parked fire is drained from here —
 *  into the queue, as the terminal hook drains — or it stays parked for
 *  good. The server's boot scan drains its orphans the same way. */
export async function scanOrphanedRuns(
  store: RunStore,
  nextDeliveryId: () => string,
  why: string,
): Promise<void> {
  try {
    // Own rows are spared only while a controller here still drives them: a
    // leg that gave up on its terminal write has let go of its row, and in
    // a lone worker no peer would ever reclaim it.
    const orphans = await store.markOrphanedRunsAsInterrupted(undefined, {
      isLocallyActive: isActiveServerRun,
    });
    if (orphans.count > 0) {
      console.log(
        `[worker] (${why}) marked ${orphans.count} orphaned run(s) as ` +
          'interrupted: ' +
          orphans.ids.slice(0, 5).join(', ') +
          (orphans.ids.length > 5 ? ` (+${orphans.ids.length - 5} more)` : ''),
      );
    }
    for (const id of orphans.ids) {
      try {
        const run = await store.getRun(id);
        if (run?.concurrencyGroup) {
          await drainPendingFireToQueue(store, run.concurrencyGroup, nextDeliveryId);
        }
      } catch (e) {
        console.error(`[worker] concurrency drain for reclaimed ${id} failed:`, e);
      }
    }
  } catch (e) {
    console.error('[worker] orphaned-run scan failed (continuing):', e);
  }
}

async function main(): Promise<void> {
  const store = await openRunStore(root);

  const runDirect = makeDirectRunDelivery({ store, root, newDeliveryId });

  // Delegate mode: ask a running server to create + execute the run.
  const runViaHttp: RunDeliveryFn = async d => {
    try {
      const res = await fetch(`${serverUrl}/api/runs/start`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sammy-user': d.ownerId,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          orchestrationName: d.orchestrationName,
          initialInput: d.body ?? '',
          allowAgentTools: true,
        }),
        // MANDATORY. Without it a hung server held the claim open forever,
        // which is the surest way to be reclaimed mid-flight and have the
        // delivery run twice. On timeout this throws and the catch below
        // reports it retryable, which is correct: no run was created.
        signal: AbortSignal.timeout(httpTimeoutMs),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        return {
          ok: false,
          error: `runs/start ${res.status}: ${t}`.slice(0, 300),
          retryable: res.status >= 500,
        };
      }
      const json = (await res.json()) as { id?: string };
      return json.id
        ? { ok: true, runId: json.id }
        : { ok: false, error: 'runs/start returned no id', retryable: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message, retryable: true };
    }
  };

  const mode = serverUrl ? 'delegate' : 'direct';
  console.log(
    `[worker] store=${store.backend}  mode=${mode}${serverUrl ? `  server=${serverUrl}` : ''}  (Ctrl-C to stop)`,
  );

  const worker = new DeliveryWorker({
    store,
    concurrency: Number(process.env.SAMMY_WORKER_CONCURRENCY) || 4,
    maxInFlightPerOrch:
      Number(process.env.SAMMY_MAX_INFLIGHT_PER_ORCH) || undefined,
    log: m => console.log(`[worker] ${m}`),
    runDelivery: serverUrl ? runViaHttp : runDirect,
  });

  const reclaimed = await store.reclaimStaleDeliveries(60_000, Date.now());
  if (reclaimed.count > 0) {
    console.log(`[worker] reclaimed ${reclaimed.count} stale delivery(ies)`);
  }
  let orphanSweep: ReturnType<typeof setInterval> | null = null;
  if (!serverUrl) {
    await scanOrphanedRuns(store, newDeliveryId, 'boot');
    // PERIODIC, not boot-only. A worker that stays up while a PEER dies would
    // otherwise never reclaim the peer's runs: they stay `running` forever,
    // hold their concurrency group forever (findActiveRunsInGroup counts
    // `running`), and no sweeper or status surface reports them — the only
    // recovery being another restart. Cadence is the lease TTL, since a lease
    // cannot have lapsed sooner.
    orphanSweep = setInterval(() => {
      void scanOrphanedRuns(store, newDeliveryId, 'periodic sweep');
    }, envPositiveInt('SAMMY_ORPHAN_SWEEP_MS', DEFAULT_LEASE_TTL_MS));
    (orphanSweep as unknown as { unref?: () => void }).unref?.();
  }
  worker.start();
  console.log('[worker] draining the durable trigger queue');

  let stopping = false;
  const shutdown = async () => {
    if (orphanSweep) clearInterval(orphanSweep);
    if (stopping) {
      // A second signal means "stop waiting" — exit non-zero so a supervisor
      // can tell a forced stop from a clean one. Previously this branch just
      // returned, so a stuck shutdown swallowed every further Ctrl-C.
      console.log('[worker] second signal — exiting now');
      process.exit(130);
    }
    stopping = true;
    console.log('\n[worker] stopping…');
    // Cap the graceful phase. `worker.stop()` awaits in-flight loop
    // iterations, and a hung handler would otherwise hang the process.
    const graceMs = Math.max(
      1_000,
      Number(process.env.SAMMY_WORKER_SHUTDOWN_GRACE_MS) || 15_000,
    );
    const timedOut = await Promise.race([
      worker.stop().then(() => false),
      new Promise<boolean>(r => setTimeout(() => r(true), graceMs)),
    ]);
    if (timedOut) {
      console.warn(
        `[worker] shutdown grace of ${graceMs}ms elapsed with work still in ` +
          'flight — exiting anyway. Those deliveries stay `claimed` until ' +
          'their lease is reclaimed (60s), then another worker takes them.',
      );
    }
    await store.close().catch(() => {});
    process.exit(timedOut ? 1 : 0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// A script when run (`npm run worker`), a module when imported by a test.
if (require.main === module) {
  main().catch(e => {
    console.error('[worker] fatal:', e);
    process.exit(1);
  });
}
