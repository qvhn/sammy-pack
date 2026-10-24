/**
 * divergence — the RUN-LEVEL thrash / retry-storm watchdog.
 *
 * The framework already makes PHASE-level contract divergence loud (the
 * interpolation-unresolved / done-degraded signals). This adds the RUN-level
 * guard: a run can be locally well-behaved (every phase reports success) yet
 * GLOBALLY pathological — the same per-item phase re-running over and over
 * because the loop can't tell "the fix is wrong" from "the validator is broken".
 * That is a RETRY STORM, and from a status poller it looks like healthy
 * progress (phases keep starting and ending). This module makes the thrash a
 * first-class, queryable property of the run.
 *
 * Like {@link computeDegradation}, the verdict is derived PURELY from the
 * durable event stream — no per-phase hot-path bookkeeping, no executor
 * threading. It's an interpretation of events the executor already emits, so it
 * stays faithful (can't drift from what happened), survives a restart (events
 * are durable), and is trivially testable (array in → verdict out). It is meant
 * to run ONCE at terminal time (alongside computeDegradation in the
 * run-controller), so a single O(events) scan is free.
 *
 * THE KEY DISTINCTION — repeat ≠ fan-out. A `map` over 100 items legitimately
 * runs its body 100 times; that is NOT thrashing. Thrashing is the SAME item's
 * phase re-running. Every leaf's `phase-end` carries a `replayKey` that encodes
 * its iteration scope (`<map>[idx]/<name>`, `<loop>@<iter>/<name>`), so the SAME
 * replayKey appearing N times means ONE phase instance ran N times — exactly the
 * storm — while 100 distinct items produce 100 distinct keys each seen once. We
 * bucket by replayKey (falling back to the bare phaseName for unscoped leaves /
 * legacy events), which cleanly separates "100 items once" from "1 item 12×".
 *
 * DEFAULT IS WARN, NOT ABORT. The verdict only flags; whether a thrashing run is
 * aborted mid-flight is a separate, opt-in policy (`divergence.abort`) the
 * run-controller enforces — default is to warn (emit the event + record the
 * flag) and let the run finish, so this is observability-first and can't make a
 * previously-completing run start failing.
 */

import type { StoredEvent } from './run-store';

/** Default repeat threshold: a single phase instance (same replayKey) running
 *  this many times is flagged as thrashing. 6 is comfortably above legitimate
 *  refinement (a 2–3 pass review loop, a retry or two) but well under the
 *  ~12×/item storm this guards against. Overridable per-orchestration via
 *  `divergence.repeatThreshold`. */
export const DEFAULT_DIVERGENCE_THRESHOLD = 6;

/** A single thrashing phase: which phase, its scoped key, and how many times it
 *  ran. `phase` is the display name (unscoped — matching every other surface);
 *  `key` is the scoped replayKey the count was bucketed under. */
export type DivergenceHotspot = {
  phase: string;
  key: string;
  repeats: number;
};

/** A run's divergence verdict. `diverged` is true iff at least one phase crossed
 *  the repeat threshold. `hotspots` lists every offending phase (most-repeated
 *  first); `maxRepeats` is the worst single count (0 when clean). */
export type DivergenceResult = {
  diverged: boolean;
  /** The repeat threshold this verdict was computed against (so a reader knows
   *  what bar was used). */
  threshold: number;
  /** Worst single phase-instance repeat count seen (0 when no phase ran > 1×). */
  maxRepeats: number;
  hotspots: DivergenceHotspot[];
};

/** Tuning for the watchdog, read off the orchestration root's
 *  `notify.divergence` (or a future top-level `divergence`). All optional;
 *  omitting the block entirely = the default WARN-only behavior at the default
 *  threshold. */
export type DivergenceConfig = {
  /** Repeat count at which a single phase instance is flagged. Default
   *  {@link DEFAULT_DIVERGENCE_THRESHOLD}. Values < 2 are clamped to 2 (a phase
   *  running once is never thrash). */
  repeatThreshold?: number;
  /** When true, a diverged run is ABORTED mid-flight by the run-controller
   *  instead of merely flagged. Default false (warn-only) — the safe default,
   *  so enabling the watchdog never makes a previously-completing run fail. */
  abort?: boolean;
};

/** Cap on the number of hotspots carried in the verdict, so a pathological run
 *  with thousands of distinct thrashing keys can't bloat the record. The worst
 *  offenders (highest repeat counts) are kept. */
const MAX_HOTSPOTS = 20;

/**
 * Scan a run's event stream and return its divergence verdict.
 *
 * Counts how many times each leaf phase INSTANCE completed, bucketed by its
 * scoped `replayKey` (so the same item's re-runs accumulate while distinct
 * fan-out items stay separate — see the module header). A `phase-end` is the
 * authoritative "this phase ran to completion once" signal; we also fold in
 * `node-retried` for the same key so a phase that retries internally without a
 * clean end still counts toward its instance's total. Any instance whose total
 * meets `threshold` is a hotspot.
 *
 * Pure + side-effect-free; safe to call repeatedly. `config.repeatThreshold`
 * overrides the default (clamped to >= 2).
 */
export function computeDivergence(
  events: ReadonlyArray<StoredEvent>,
  config?: DivergenceConfig,
): DivergenceResult {
  const threshold = Math.max(
    2,
    Math.floor(config?.repeatThreshold ?? DEFAULT_DIVERGENCE_THRESHOLD),
  );

  // key → { phase (display name), repeats }. Keyed by the scoped replayKey when
  // present, else the bare phase name (unscoped leaf / legacy event).
  const counts = new Map<string, { phase: string; repeats: number }>();

  const bump = (phaseName: unknown, replayKey: unknown) => {
    if (typeof phaseName !== 'string' || phaseName.length === 0) return;
    const key =
      typeof replayKey === 'string' && replayKey.length > 0
        ? replayKey
        : phaseName;
    const cur = counts.get(key);
    if (cur) cur.repeats += 1;
    else counts.set(key, { phase: phaseName, repeats: 1 });
  };

  for (const e of events) {
    const ev = e as {
      type: string;
      phaseName?: unknown;
      replayKey?: unknown;
    };
    // `phase-end` = one completed run of a leaf instance (the primary signal).
    // `node-retried` = an in-node retry of the SAME instance that hasn't ended
    // yet — fold it in so a phase that storms via `retry` (not a loop) still
    // accumulates. node-retried has no replayKey, so it buckets by phaseName;
    // that's fine — an unscoped storming phase is exactly the bare-name case.
    if (ev.type === 'phase-end') bump(ev.phaseName, ev.replayKey);
    else if (ev.type === 'node-retried') bump(ev.phaseName, ev.replayKey);
  }

  const hotspots: DivergenceHotspot[] = [];
  let maxRepeats = 0;
  for (const [key, { phase, repeats }] of counts) {
    if (repeats > maxRepeats) maxRepeats = repeats;
    if (repeats >= threshold) hotspots.push({ phase, key, repeats });
  }
  // Worst offenders first; bound the list.
  hotspots.sort((a, b) => b.repeats - a.repeats);
  const bounded = hotspots.slice(0, MAX_HOTSPOTS);

  return {
    diverged: bounded.length > 0,
    threshold,
    maxRepeats,
    hotspots: bounded,
  };
}

/** Bound on the rendered divergence summary line. */
export const DIVERGENCE_SUMMARY_MAX_CHARS = 600;

/**
 * Render the divergence verdict as a compact one-line tail for the terminal
 * report / notify text — e.g.
 * `RETRY STORM: 2 phase(s) thrashing (validate ×12, implement ×11; threshold 6)`.
 * Empty string for a clean verdict so a caller can unconditionally append it.
 */
export function formatDivergenceSummary(result: DivergenceResult): string {
  if (!result.diverged || result.hotspots.length === 0) return '';
  const parts = result.hotspots.map(h => `${h.phase} ×${h.repeats}`);
  let joined = parts.join(', ');
  const suffix = `; threshold ${result.threshold}`;
  const room = DIVERGENCE_SUMMARY_MAX_CHARS - suffix.length;
  if (joined.length > room) joined = `${joined.slice(0, Math.max(0, room - 1))}…`;
  return `RETRY STORM: ${result.hotspots.length} phase(s) thrashing (${joined}${suffix})`;
}
