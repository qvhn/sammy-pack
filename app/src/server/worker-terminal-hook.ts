/**
 * worker-terminal-hook — gives the standalone worker (direct mode) the same
 * on-terminal behavior the server has: reactive eventing (P3) +
 * `lifecycle.errorOrchestration` recovery. Closes the gap where a direct-mode
 * run silently fired neither.
 *
 * Eventing is done against the store + workspace directly (no in-process
 * trigger registry): on a run's terminal, find the orchestrations that
 * subscribe to `<orch>.done` / `<orch>.error` (by scanning the examples dir)
 * and enqueue an `events` delivery for each — which this same worker drains on
 * its next poll. chain_depth propagates from the producing delivery and is
 * capped, the same loop-guard the server uses. errorOrchestration recovery is
 * delegated to a `startRecoveryRun` callback the worker supplies (it has the
 * run engine).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { DeliveryStatus, RunStatus, RunStore } from './run-store';
import type { Node } from '../types';
import { cleanupWorktrees } from './worktrees';
import {
  describeScrub,
  NON_JSON_PLACEHOLDER,
  scrubPayload,
  type ScrubPolicy,
} from './payload-scrub';
import {
  fireGateNotify,
  fireTerminalNotify,
  isGatePause,
  type TerminalNotifyInput,
} from './notify';

/** Orchestrations whose `triggers` include `{ kind: 'events', event }`.
 *  A readdir+parse of examples/ per run-terminal — negligible at workspace
 *  scale; if the workspace grows large, cache + invalidate on file change. */
async function findEventSubscribers(
  examplesDir: string,
  eventName: string,
): Promise<Array<{ name: string; scrub?: ScrubPolicy }>> {
  const out: Array<{ name: string; scrub?: ScrubPolicy }> = [];
  const entries = await fs.readdir(examplesDir).catch(() => [] as string[]);
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    try {
      const orch = JSON.parse(
        await fs.readFile(path.join(examplesDir, f), 'utf8'),
      ) as Node;
      const triggers = Array.isArray(orch.triggers) ? orch.triggers : [];
      const t = triggers.find(x => x.kind === 'events' && x.event === eventName);
      if (typeof orch.name === 'string' && t) {
        out.push({
          name: orch.name,
          ...(t.kind === 'events' && t.scrub !== undefined ? { scrub: t.scrub } : {}),
        });
      }
    } catch {
      // skip malformed files
    }
  }
  return out;
}

/**
 * Release a run's concurrency group into the WORKER's own queue: dequeue the
 * oldest fire parked behind `group` and record it as a `pending` delivery, so
 * this worker fires it through its start-gate on the next poll (which re-parks
 * it if the group is busy again, or skips it if the policy says so).
 *
 * `dequeueNextPendingFire` was only ever called from the server's terminal
 * drain. In the documented worker-only topology nothing drained at all, so a
 * fire parked behind a worker-executed run waited forever. This is the
 * server's `drainPendingFire` with one deliberate difference: the fire
 * re-enters through the durable queue instead of being started inline. The
 * hook runs on the run's terminal path, and starting a run from there would
 * re-enter the start-gate's group lock — the deadlock the server's
 * cancel-existing restructure removed.
 *
 * The dequeue already DELETED the row, so a delivery that cannot be recorded
 * (a store hiccup, an idempotency collision) re-parks the fire rather than
 * losing it. Returns the delivery id, or null when nothing was parked.
 */
export async function drainPendingFireToQueue(
  store: Pick<
    RunStore,
    'dequeueNextPendingFire' | 'recordDelivery' | 'enqueuePendingFire'
  >,
  group: string,
  newDeliveryId: () => string,
  log: (msg: string) => void = m => console.log(`[worker] ${m}`),
): Promise<string | null> {
  const next = await store.dequeueNextPendingFire(group);
  if (!next) return null;
  const id = newDeliveryId();
  try {
    const recorded = await store.recordDelivery({
      id,
      // The label the server's drain fires under. The KIND is part of the
      // gate's input, not just a label: `effectiveConcurrency` takes an
      // explicit root `concurrency` block whatever the kind, but derives the
      // implicit `sammy:cron:<name>` group ONLY for kind `cron`. So a fire
      // parked under an implicit cron group and re-driven from here re-enters
      // with no group — the same drain-kind hazard the server's half of this
      // path carries.
      kind: 'concurrency-drain',
      name: group,
      orchestrationName: next.orchName,
      // One drain, one key: a parked fire is already deduplicated at ingress
      // and must never collapse onto an earlier drain of the same group.
      idempotencyKey: `auto:drain:${id}`,
      keySource: 'auto',
      status: 'pending' as DeliveryStatus,
      body: next.initialInput,
      ownerId: next.ownerId,
      receivedAt: Date.now(),
    });
    if (!recorded) throw new Error('delivery row rejected as a duplicate');
    log(`concurrency: drained queued ${next.orchName} (group ${group}) → delivery ${id}`);
    return id;
  } catch (e) {
    try {
      await store.enqueuePendingFire(group, next);
      log(
        `concurrency: drained ${next.orchName} (group ${group}) but could not ` +
          `queue it (${(e as Error)?.message ?? e}) — RE-PARKED for the next drain.`,
      );
    } catch (e2) {
      console.error(
        `[worker] LOST a parked fire for ${next.orchName} (group ${group}): ` +
          `could not queue it (${(e as Error)?.message ?? e}) and re-park failed:`,
        e2,
      );
    }
    return null;
  }
}

export type WorkerTerminalHookOpts = {
  orchName: string;
  orch: Node;
  ownerId: string;
  store: RunStore;
  examplesDir: string;
  /** Workspace root — where the run's worktrees live (root `worktrees`).
   *  Omit to skip worktree cleanup. */
  root?: string;
  newDeliveryId: () => string;
  /** Reactive-chain loop guard. Default 5. */
  maxChainDepth?: number;
  /** Start the recovery orchestration on error (worker supplies it — it owns
   *  the run engine). Omit to skip errorOrchestration. */
  startRecoveryRun?: (
    recoveryOrchName: string,
    envelope: string,
    ownerId: string,
  ) => Promise<void>;
};

export function makeWorkerTerminalHook(opts: WorkerTerminalHookOpts): (info: {
  id: string;
  status: RunStatus;
  error: string | null;
  /** Set when the leg concluded `status` but could not RECORD it. See the
   *  guard below — kept in sync with the server's `buildTerminalHook`. */
  terminalWriteError?: string;
  degraded?: boolean;
  degradationReasons?: TerminalNotifyInput['degradationReasons'];
  divergence?: TerminalNotifyInput['divergence'];
  notes?: TerminalNotifyInput['notes'];
}) => Promise<void> {
  const maxDepth = opts.maxChainDepth ?? 5;
  const { store, examplesDir, orchName, orch, ownerId } = opts;

  return async ({
    id,
    status,
    error,
    terminalWriteError,
    degraded,
    degradationReasons,
    divergence,
    notes,
  }) => {
    // 0) A terminal that was never RECORDED owns no side effects. The row
    //    still reads `running`, so the orphan scan reclaims it as
    //    `interrupted` and the next leg (an operator's resume, or the server's
    //    auto-resume) re-walks to the same terminal and fires this hook again
    //    — and nothing here is idempotent: the event deliveries are keyed
    //    `auto:evt:<runId>:<sub>` but the reclaim is a lease TTL out, past the
    //    auto-dedupe window, and the recovery run has no key at all. So one
    //    logical outcome bought a duplicate reactive fan-out and a duplicate
    //    recovery run, which spends. The authoritative terminal is whichever
    //    leg records one; the drain is skipped too, because `scanOrphanedRuns`
    //    drains a reclaimed run's group itself.
    if (terminalWriteError) {
      console.warn(
        `[worker] terminal hook for ${id} SKIPPED — ${status} could not be ` +
          `recorded (${terminalWriteError}); the row stays \`running\` and ` +
          'will be reclaimed as `interrupted`, and the leg that records the ' +
          'terminal owns the events, recovery and drain.',
      );
      return;
    }

    // 1) Publish the lifecycle event to subscribers (done / error only).
    if (status === 'done' || status === 'error') {
      try {
        const parent = await store.findDeliveryByRunId(id);
        const depth = (parent?.chainDepth ?? 0) + 1;
        if (depth <= maxDepth) {
          const eventName = `${orchName}.${status}`;
          const subs = await findEventSubscribers(examplesDir, eventName);
          if (subs.length > 0) {
            const run = await store.getRun(id);
            // KEEP IN SYNC with the server's publishEvent body in
            // sammy-pack-api.ts (buildTerminalHook) — a subscriber may depend
            // on this shape, so the two producer paths must stay identical.
            const body = JSON.stringify({
              runId: id,
              orchestration: orchName,
              status,
              error: error ?? undefined,
              output: run?.lastOutput ?? undefined,
            });
            for (const { name: sub, scrub } of subs) {
              // The subscriber's ingress `scrub`, exactly as the server's
              // deliver() applies it — a policy that throws withholds the body.
              let subBody = body;
              let detail: string | undefined;
              if (scrub) {
                try {
                  const r = scrubPayload(body, scrub);
                  subBody = r.body;
                  detail = describeScrub(r);
                } catch (e) {
                  subBody = NON_JSON_PLACEHOLDER;
                  detail = `scrub failed (${(e as Error).message}) — body withheld`;
                }
              }
              await store.recordDelivery({
                id: opts.newDeliveryId(),
                kind: 'events',
                name: eventName,
                orchestrationName: sub,
                idempotencyKey: `auto:evt:${id}:${sub}`,
                keySource: 'auto',
                status: 'pending' as DeliveryStatus,
                body: subBody,
                ...(detail ? { detail } : {}),
                ownerId,
                receivedAt: Date.now(),
                chainDepth: depth,
              });
            }
          }
        } else {
          console.warn(
            `[worker] event "${orchName}.${status}" dropped — chain depth ${depth} > ${maxDepth} (loop guard)`,
          );
        }
      } catch (e) {
        console.error(`[worker] event publish for ${id} failed:`, e);
      }
    }

    // 1b) Outbound notifications — the same `notify.onTerminal` /
    //     `notify.onGate` the server fires, so a worker-only deployment is not
    //     silent. Best-effort; never breaks finalization.
    if (orch.notify?.onTerminal || (status === 'paused' && orch.notify?.onGate)) {
      try {
        const run = await store.getRun(id);
        if (orch.notify?.onTerminal) {
          fireTerminalNotify({
            notify: orch.notify,
            runId: id,
            orchestration: orchName,
            status,
            lastOutput: run?.lastOutput,
            degraded,
            degradationReasons,
            // The same end-of-run picture the server's envelope carries.
            divergence,
            notes,
          });
        }
        if (status === 'paused' && orch.notify?.onGate && isGatePause(run)) {
          fireGateNotify({
            notify: orch.notify,
            runId: id,
            orchestration: orchName,
            gate: run?.pausedFor ?? null,
            lastOutput: run?.lastOutput,
            publicUrl: process.env.SAMMY_PUBLIC_URL?.trim() || undefined,
          });
        }
      } catch (e) {
        console.error(`[worker] notify for ${id} failed:`, e);
      }
    }

    // 1c) Root `worktrees` cleanup — the server's policy, applied here so a
    //     worker-only deployment does not accumulate worktrees.
    if (opts.root && Array.isArray(orch.worktrees) && orch.worktrees.length > 0) {
      try {
        for (const o of await cleanupWorktrees(orch.worktrees, {
          root: opts.root,
          runId: id,
          orchestration: orchName,
          status,
        })) {
          console.log(`[worker] worktree "${o.name}" for ${id} ${o.action} (${o.path})`);
        }
      } catch (e) {
        console.error(`[worker] worktree cleanup for ${id} failed:`, e);
      }
    }

    // 2) lifecycle.errorOrchestration recovery.
    const recovery = orch.lifecycle?.errorOrchestration;
    if (recovery && status === 'error' && opts.startRecoveryRun) {
      const envelope = JSON.stringify({
        failedRunId: id,
        failedOrchestration: orchName,
        error: error ?? 'unknown',
      });
      try {
        await opts.startRecoveryRun(recovery, envelope, ownerId);
      } catch (e) {
        console.error(`[worker] errorOrchestration for ${id} failed:`, e);
      }
    }

    // 3) Release the concurrency group. A run holds its group while `running`
    //    OR `paused`; any other terminal frees it, and the fire parked behind
    //    it has to be re-driven from HERE — the worker has no other drain.
    //    Best-effort: a drain hiccup must never break run finalization.
    if (status !== 'paused') {
      try {
        const run = await store.getRun(id);
        if (run?.concurrencyGroup) {
          await drainPendingFireToQueue(store, run.concurrencyGroup, opts.newDeliveryId);
        }
      } catch (e) {
        console.error(`[worker] concurrency drain for ${id} failed:`, e);
      }
    }
  };
}
