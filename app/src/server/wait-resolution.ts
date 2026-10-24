/**
 * Durable-wait resolution — pure derivation over the run's event stream.
 *
 * A `wait` leaf parks a server-owned run exactly like a lock gate
 * (snapshot + status='paused'), but nothing human ever answers it — the
 * SERVER must decide when the run can move again. This module is that
 * decision, split the same way the rest of the server splits durable state:
 *
 *   - the EVENT STREAM is the source of truth. `wait-started` events carry
 *     each wait instance's absolute deadline / signal name (fixed at first
 *     crossing); `signal-received` events are the durable buffer of
 *     deliveries from POST /api/runs/:id/signal; a wait that finished has a
 *     `phase-end` with the same replayKey (and a leafOutputs checkpoint).
 *   - {@link deriveWaitState} folds those into what a RESUMED leg needs:
 *     the still-unresolved wait specs (so a re-crossed `wait` re-parks
 *     against its ORIGINAL deadline instead of re-arming the clock) and the
 *     not-yet-consumed signal payloads (FIFO per name). The executor itself
 *     then does all the semantics — a due timer completes, an undue one
 *     re-parks, a buffered signal is consumed — so resolution logic lives in
 *     exactly one place (runWaitPhase).
 *   - {@link sweepDueWaits} is the sweeper core (mirrors sweepStaleGates):
 *     scan paused runs' HEADERS (stateJson.pendingWait — the cheap index the
 *     run-controller writes at pause time; no event read), and ask the API
 *     layer to resume the ones that are actionable. Timer due and signal
 *     deadline are header-only checks; the one case that needs events — a
 *     signal that was delivered while the leg was still LIVE, so it's
 *     buffered in the log but nobody was listening when the run parked — is
 *     scanned ONCE per pause leg (deduped via `checkedSignalScans`, re-armed
 *     by a restart, which is exactly when a re-check is wanted).
 *
 * Consumption accounting: a signal payload is consumed by AT MOST one wait.
 * Completed signal-waits are counted per name (a resolved wait with
 * `signal: S` consumed exactly one `S` delivery, FIFO), and that many
 * deliveries are dropped from the derived buffer — so a judge-style flow
 * that waits on the same signal name repeatedly can't double-consume one
 * delivery, and a rejected/timed-out wait (phase-error, no phase-end)
 * consumes nothing.
 */

import type { PendingWaitSpec } from '../llm/executor';
import type { RunStore, StoredEvent } from './run-store';

export type WaitSeed = {
  /** Unresolved wait specs, keyed by the wait instance's replayKey. */
  pendingWaits: Record<string, PendingWaitSpec>;
  /** Buffered, not-yet-consumed signal payloads — FIFO per signal name. */
  deliveredSignals: Record<string, string[]>;
};

/** Fold the durable event stream (+ the leafOutputs checkpoint map) into the
 *  executor seed for a resumed leg. Pure — same inputs, same answer. */
export function deriveWaitState(
  events: ReadonlyArray<StoredEvent>,
  leafOutputs: Record<string, string>,
): WaitSeed {
  // Last wait-started per replayKey (in-memory keepalives re-emit the same
  // spec; last write wins and is identical in practice).
  const started = new Map<string, PendingWaitSpec>();
  // replayKeys that completed — a phase-end with that replayKey exists.
  const ended = new Set<string>(Object.keys(leafOutputs));
  // All signal deliveries in arrival order, per name.
  const delivered = new Map<string, string[]>();

  for (const e of events) {
    if (e.type === 'wait-started') {
      const ev = e as {
        replayKey?: unknown;
        kind?: unknown;
        resumeAt?: unknown;
        signal?: unknown;
        deadline?: unknown;
      };
      if (
        typeof ev.replayKey === 'string' &&
        (ev.kind === 'timer' || ev.kind === 'signal')
      ) {
        started.set(ev.replayKey, {
          replayKey: ev.replayKey,
          kind: ev.kind,
          ...(typeof ev.resumeAt === 'number' ? { resumeAt: ev.resumeAt } : {}),
          ...(typeof ev.signal === 'string' ? { signal: ev.signal } : {}),
          ...(typeof ev.deadline === 'number' ? { deadline: ev.deadline } : {}),
        });
      }
    } else if (e.type === 'phase-end') {
      const rk = (e as { replayKey?: unknown }).replayKey;
      if (typeof rk === 'string') ended.add(rk);
    } else if (e.type === 'signal-received') {
      const ev = e as { signal?: unknown; payload?: unknown };
      if (typeof ev.signal === 'string') {
        const q = delivered.get(ev.signal) ?? [];
        q.push(typeof ev.payload === 'string' ? ev.payload : '');
        delivered.set(ev.signal, q);
      }
    }
  }

  const pendingWaits: Record<string, PendingWaitSpec> = {};
  // Per-name count of deliveries already consumed by COMPLETED signal-waits.
  const consumedByName = new Map<string, number>();
  for (const [key, spec] of started) {
    if (ended.has(key)) {
      if (spec.kind === 'signal' && spec.signal) {
        consumedByName.set(
          spec.signal,
          (consumedByName.get(spec.signal) ?? 0) + 1,
        );
      }
      continue;
    }
    pendingWaits[key] = spec;
  }

  const deliveredSignals: Record<string, string[]> = {};
  for (const [name, queue] of delivered) {
    const remaining = queue.slice(consumedByName.get(name) ?? 0);
    if (remaining.length > 0) deliveredSignals[name] = remaining;
  }

  return { pendingWaits, deliveredSignals };
}

/** Why {@link sweepDueWaits} asked for a resume. */
export type WaitDueReason = 'timer-due' | 'signal-buffered' | 'signal-deadline';

/** Read `stateJson.pendingWait` off a run header, defensively. */
export function pendingWaitOf(
  stateJson: unknown,
): PendingWaitSpec | null {
  const pw = (stateJson as { pendingWait?: unknown } | null)?.pendingWait as
    | PendingWaitSpec
    | undefined;
  if (!pw || typeof pw !== 'object') return null;
  if (pw.kind !== 'timer' && pw.kind !== 'signal') return null;
  if (typeof pw.replayKey !== 'string') return null;
  return pw;
}

/**
 * Sweeper core: find paused runs whose durable wait is actionable and hand
 * each to `resume`. Header-only except the once-per-pause-leg buffered-signal
 * scan (see module docs). A resume callback that throws only fails that run's
 * entry — the sweep continues (and the next tick retries), mirroring the
 * stale-gate sweeper's fault isolation.
 */
export async function sweepDueWaits(
  store: Pick<RunStore, 'listPausedRuns' | 'getRun'>,
  opts: {
    resume: (runId: string, reason: WaitDueReason) => Promise<void>;
    now?: number;
    /** Caller-owned dedupe set for the one-time buffered-signal event scan,
     *  keyed `${runId}:${replayKey}`. Omit to scan on every sweep (tests). */
    checkedSignalScans?: Set<string>;
  },
): Promise<void> {
  const now = opts.now ?? Date.now();
  // listPausedRuns is UNBOUNDED (unlike listRuns's newest-500 window) so a
  // wait parked long ago on a busy store can never age out of the
  // sweeper's sight — an invisible park would simply never resume.
  const headers = await store.listPausedRuns();
  for (const h of headers) {
    if (h.status !== 'paused') continue; // defensive; the query filters
    const pw = pendingWaitOf(h.stateJson);
    if (!pw) continue;
    try {
      if (pw.kind === 'timer') {
        if (typeof pw.resumeAt === 'number' && now >= pw.resumeAt) {
          await opts.resume(h.id, 'timer-due');
        }
        continue;
      }
      // Signal wait: deadline first (header-only) …
      if (typeof pw.deadline === 'number' && now >= pw.deadline) {
        await opts.resume(h.id, 'signal-deadline');
        continue;
      }
      // … then the one-time scan for a delivery that arrived BEFORE the
      // pause landed (buffered in events; the signal endpoint's live
      // fast-path only covers deliveries while already paused).
      const scanKey = `${h.id}:${pw.replayKey}`;
      if (opts.checkedSignalScans?.has(scanKey)) continue;
      opts.checkedSignalScans?.add(scanKey);
      const run = await store.getRun(h.id);
      if (!run) continue;
      const leafOutputs =
        ((run.stateJson as { leafOutputs?: Record<string, string> } | null)
          ?.leafOutputs) ?? {};
      const seed = deriveWaitState(run.events, leafOutputs);
      const q = pw.signal ? seed.deliveredSignals[pw.signal] : undefined;
      if (q && q.length > 0) {
        await opts.resume(h.id, 'signal-buffered');
      }
    } catch (err) {
      console.error(
        `[wait-sweep] resume check failed for run ${h.id} (ignored):`,
        err,
      );
    }
  }
}
