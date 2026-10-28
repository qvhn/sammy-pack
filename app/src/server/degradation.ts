/**
 * degradation — the "done-but-degraded" run signal.
 *
 * A run can reach a NON-error terminal status (`done`) while having silently
 * swallowed an error, finalized a fan-out with only some of its items, taken a
 * documented fallback path, or had a node aborted by the stall watchdog and
 * carried on. From the outside that run looks identical to a clean one — its
 * status is `done`, and a poller / notify hook / dashboard reports success.
 * That masking is the failure mode this module attacks: it makes the degraded
 * outcome a FIRST-CLASS, queryable property of the run rather than something a
 * human has to reconstruct by reading the event log.
 *
 * The taxonomy is derived PURELY from the durable event stream — the same
 * pattern the rest of the codebase uses to derive run state (summarizeRun,
 * derivePreviewFromEvents, deriveRunStatus). Nothing is threaded through the
 * executor's mutable context; a degradation is just an interpretation of events
 * the executor already emits. That keeps the signal faithful (it can't drift
 * from what actually happened), reconstructible after a restart (the events are
 * durable), and trivially testable (pure function, array in → verdict out).
 *
 * IMPORTANT — a degradation is only meaningful for a run whose final status
 * would otherwise be `done`. A run that ended `error` / `cancelled` already
 * carries its bad-outcome signal in `status`; flagging it "degraded" too would
 * be noise. So the run-controller calls {@link computeDegradation} only on a
 * `done` terminal (see run-controller.ts).
 */

import type { StoredEvent } from './run-store';

/** One reason a run is degraded — the offending node plus a short, human-
 *  readable explanation. `phase` is the node name from the triggering event
 *  (display name, unscoped — matching every other surface). */
export type DegradationReason = {
  phase: string;
  reason: string;
};

/** A run's degradation verdict. `degraded` is true iff `reasons` is non-empty
 *  — they always agree, so a caller can branch on either. */
export type DegradationResult = {
  degraded: boolean;
  reasons: DegradationReason[];
};

/** Max chars of a swallowed error / unresolved-ref list folded into a reason
 *  string, so one chatty failure can't bloat the run record. */
const REASON_TEXT_MAX = 300;

function clip(s: string): string {
  const t = s.trim();
  return t.length > REASON_TEXT_MAX ? `${t.slice(0, REASON_TEXT_MAX)}…` : t;
}

/**
 * Scan a run's event stream and return its degradation verdict.
 *
 * What counts as a degradation (each only signals a SWALLOWED problem — one the
 * run continued past rather than failing on):
 *
 *   - `composite-partial` — a fan-out (map / parallel / converge) finalized
 *     with only SOME children's results instead of erroring: it hit its
 *     deadline with children in flight (finalize-with-partials), or
 *     some children FAILED while siblings succeeded (`failed` set on the
 *     event). Either way the run produced a reduced result; downstream
 *     consumed an incomplete aggregate.
 *   - `phase-error` — a phase threw. On a `done` run this error did NOT become
 *     terminal, which means it was swallowed: either by `continueOnError`, or
 *     by a `finally`-finalizer whose sequence still succeeded, or by an
 *     `onError` recovery branch. The work that phase was supposed to do didn't
 *     happen.
 *   - `node-stalled` — the stall watchdog aborted a node for making no
 *     progress. On a `done` run the abort was absorbed (a `continueOnError`
 *     sibling, an `onError`, or a fan-out partial) and the run carried on
 *     short of that node's output.
 *   - `node-recovered` — a node exhausted its retries and its `onError`
 *     recovery branch ran. That is a documented FALLBACK path: the primary path
 *     failed and the run delivered the recovery's output in its place.
 *   - `interpolation-unresolved` — `${ref}` placeholders didn't resolve and
 *     were left as literals (the documented default). The phase ran with a
 *     prompt that still contained raw `${…}` text.
 *   - `binding-empty` — a `${ref}` bound to an upstream `as` output resolved to
 *     EMPTY: the producing phase wrote nothing (a truncated/errored agent), so
 *     this phase ran on a silently-blank input. On a `done` run this masks a
 *     report/publish phase that summarized nothing.
 *
 * DELIBERATELY NOT counted:
 *   - `node-retried` on its own — a retry that ultimately SUCCEEDS is the
 *     resilience layer working as designed (a transient blip, fully recovered).
 *     If retries are exhausted the run either recovers (→ `node-recovered`,
 *     counted) or fails (→ terminal `error`, not a `done` run at all).
 *   - `tools-warning` — an author/config concern (a tool stripped because it
 *     wasn't enabled), surfaced at author-lint + as its own event; it isn't a
 *     degradation of the run's actual WORK.
 *   - `budget-halted` / `run-halted` — a halt makes the run terminal `error`
 *     (budget) or is an intentional early return (`halt`), neither of which is
 *     a silently-degraded `done`.
 *
 * The order of `reasons` follows event order (chronological), so the first
 * degradation a reader sees is the first that happened.
 */
export function computeDegradation(
  events: ReadonlyArray<StoredEvent>,
): DegradationResult {
  const reasons: DegradationReason[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'composite-partial': {
        const ev = e as unknown as {
          phaseName?: string;
          kind?: string;
          completed?: number;
          total?: number;
          failed?: number;
        };
        const completed = Number(ev.completed ?? 0);
        const total = Number(ev.total ?? 0);
        // `failed` distinguishes the two partial triggers: present → some
        // children FAILED and the composite salvaged the sibling successes;
        // absent → the deadline fired with children still in flight.
        const cause =
          typeof ev.failed === 'number' && ev.failed > 0
            ? `${ev.failed} failed`
            : 'the rest hit the deadline';
        reasons.push({
          phase: typeof ev.phaseName === 'string' ? ev.phaseName : '(unknown)',
          reason: `partial ${ev.kind ?? 'composite'} finalize — ${completed}/${total} items completed (${cause})`,
        });
        break;
      }
      case 'phase-error': {
        const ev = e as unknown as { phaseName?: string; error?: string };
        reasons.push({
          phase: typeof ev.phaseName === 'string' ? ev.phaseName : '(unknown)',
          reason: `swallowed phase error: ${clip(String(ev.error ?? 'unknown error'))}`,
        });
        break;
      }
      case 'node-stalled': {
        const ev = e as unknown as { phaseName?: string; stallSeconds?: number };
        reasons.push({
          phase: typeof ev.phaseName === 'string' ? ev.phaseName : '(unknown)',
          reason: `stall-aborted (no progress for ${ev.stallSeconds ?? '?'}s) but the run continued`,
        });
        break;
      }
      case 'node-recovered': {
        const ev = e as unknown as { phaseName?: string; error?: string };
        reasons.push({
          phase: typeof ev.phaseName === 'string' ? ev.phaseName : '(unknown)',
          reason: `recovered via onError fallback after: ${clip(String(ev.error ?? 'unknown error'))}`,
        });
        break;
      }
      case 'interpolation-unresolved': {
        const ev = e as unknown as { phaseName?: string; refs?: unknown };
        const refs = Array.isArray(ev.refs) ? ev.refs.map(String) : [];
        reasons.push({
          phase: typeof ev.phaseName === 'string' ? ev.phaseName : '(unknown)',
          reason: `unresolved interpolation refs left as literals: ${clip(refs.join(', '))}`,
        });
        break;
      }
      case 'binding-empty': {
        // A `${ref}` bound to an upstream `as` output that resolved to EMPTY —
        // the producing phase wrote nothing (e.g. it truncated on its token
        // ceiling), so this phase ran on a silently-empty input. On a `done`
        // run that masks a report/publish phase that summarized nothing.
        const ev = e as unknown as { phaseName?: string; bindings?: unknown };
        const b = Array.isArray(ev.bindings) ? ev.bindings.map(String) : [];
        reasons.push({
          phase: typeof ev.phaseName === 'string' ? ev.phaseName : '(unknown)',
          reason: `empty upstream binding(s) fed in as blank: ${clip(b.join(', '))}`,
        });
        break;
      }
      case 'harness-step': {
        // An advisory harness may skip a step; the run then finished without
        // doing it. (A failed optional step already arrives as a phase-error;
        // a step a falsy `when` skipped is the orchestration working.)
        const ev = e as unknown as { phaseName?: string; status?: string; by?: string; reason?: string };
        if (ev.status === 'skipped' && ev.by === 'harness') {
          reasons.push({
            phase: typeof ev.phaseName === 'string' ? ev.phaseName : '(unknown)',
            reason: `skipped by the harness: ${clip(String(ev.reason ?? 'no reason given'))}`,
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return { degraded: reasons.length > 0, reasons };
}

/** Render the degradation verdict as a compact one-line tail for the terminal
 *  report / notify text — e.g. `DEGRADED (2): swallowed phase error: … ; partial
 *  map finalize — 1/3 …`. Empty string for a clean (non-degraded) verdict so a
 *  caller can unconditionally append it. Each reason is `phase: reason`, joined
 *  by ` ; `, and the whole line is bounded so a many-reason run can't produce a
 *  giant notify body. */
export function formatDegradationSummary(result: DegradationResult): string {
  if (!result.degraded || result.reasons.length === 0) return '';
  const parts = result.reasons.map(r => `${r.phase}: ${r.reason}`);
  const joined = parts.join(' ; ');
  const bounded =
    joined.length > NOTIFY_DEGRADED_MAX_CHARS
      ? `${joined.slice(0, NOTIFY_DEGRADED_MAX_CHARS)}…`
      : joined;
  return `DEGRADED (${result.reasons.length}): ${bounded}`;
}

/** Bound on the rendered degradation summary line (formatDegradationSummary). */
export const NOTIFY_DEGRADED_MAX_CHARS = 1000;
