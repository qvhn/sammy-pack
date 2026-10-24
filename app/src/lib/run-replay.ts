/**
 * Deterministic replay — turn a finished run into a regression test.
 *
 * THE GAP THIS FILLS: tracing vendors can only approximate replay because
 * they observe runs from the outside. A framework that owns the node tree
 * AND checkpoints every leaf already has everything needed: each
 * `phase-end` event carries the leaf's `replayKey` and its exact output,
 * and the executor already accepts a `replayOutputs` table that makes a
 * leaf return a recorded output instead of dispatching an agent.
 *
 * So a recorded run can be re-executed with ZERO model calls. What that
 * tests is the part of an orchestration that silently breaks when you edit
 * it: the CONTROL FLOW. Change a `when` predicate, a `switch` case, a
 * route's branch keys or a loop's stop condition, and the tree quietly
 * takes a different path — today you only find out by paying for a live
 * run. Replay answers "given the same agent outputs, does my edited
 * orchestration still walk the same way?" in milliseconds and for free.
 *
 * Divergence is reported, never hidden:
 *   - `missing`  — a leaf the new walk reached that the recording has no
 *                  output for. The walk went somewhere the recorded run
 *                  never did (a new phase, or a branch that used to be
 *                  skipped). These are what make a replay fail.
 *   - `unused`   — a recorded leaf the new walk never reached. The walk
 *                  stopped going somewhere it used to (a phase removed,
 *                  or now skipped by a `when`).
 *   - `order`    — leaves executed in a different relative order.
 */

export type RecordedEvent = Record<string, unknown> & { type: string };

export type RunRecording = {
  /** replayKey → the leaf's recorded output, ready for `replayOutputs`. */
  outputs: Record<string, string>;
  /** Leaf replayKeys in the order the recorded run completed them. */
  order: string[];
};

/**
 * Build a replay recording from a run's durable event stream.
 *
 * Keyed by each `phase-end`'s `replayKey` — the iteration-scoped identity
 * (`<map>[2]/qa`, `<loop>@3/refine`) the executor itself uses — so a leaf
 * inside a fan-out or a refinement loop replays its OWN output rather than
 * collapsing onto a bare phase name. A phase-end with no replayKey (older
 * runs) falls back to its phase name.
 *
 * The LAST write for a key wins: a leaf that genuinely re-executed (retry,
 * stall recovery) should replay the output the run actually carried
 * forward.
 */
export function deriveRecording(
  events: ReadonlyArray<RecordedEvent>,
): RunRecording {
  const outputs: Record<string, string> = {};
  const order: string[] = [];
  for (const e of events) {
    if (e.type !== 'phase-end') continue;
    const key =
      typeof e.replayKey === 'string' && e.replayKey
        ? e.replayKey
        : typeof e.phaseName === 'string'
          ? e.phaseName
          : null;
    if (!key) continue;
    const output = typeof e.output === 'string' ? e.output : '';
    if (!(key in outputs)) order.push(key);
    outputs[key] = output;
  }
  return { outputs, order };
}

export type ReplayDivergence = {
  /** Leaves the replay reached that the recording cannot answer — the walk
   *  went somewhere the recorded run did not. Fails the replay. */
  missing: string[];
  /** Recorded leaves the replay never reached — the walk stopped going
   *  somewhere it used to. */
  unused: string[];
  /** True when the leaves both runs share executed in a different relative
   *  order. */
  reordered: boolean;
};

export type ReplayResult = ReplayDivergence & {
  /** Leaf replayKeys the replay walk executed, in order. */
  walked: string[];
  /** No missing leaves, no unused leaves, same relative order. */
  faithful: boolean;
  /** A run-level error thrown during the replay walk, if any. */
  error?: string;
};

/** Compare a replay walk against the recording it replayed. */
export function diffWalk(
  recording: RunRecording,
  walked: ReadonlyArray<string>,
): ReplayDivergence {
  const recordedSet = new Set(recording.order);
  const walkedSet = new Set(walked);
  const missing = walked.filter(k => !recordedSet.has(k));
  const unused = recording.order.filter(k => !walkedSet.has(k));
  // Order is compared over the INTERSECTION — leaves that both runs
  // executed. Comparing raw sequences would report every added or removed
  // phase twice (once as missing/unused, once as a reorder).
  const commonRecorded = recording.order.filter(k => walkedSet.has(k));
  const commonWalked = walked.filter(k => recordedSet.has(k));
  const reordered =
    commonRecorded.length === commonWalked.length &&
    commonRecorded.some((k, i) => commonWalked[i] !== k);
  return { missing, unused, reordered };
}

/** Human-readable one-liner per divergence, for a CLI report. */
export function describeDivergence(d: ReplayDivergence): string[] {
  const lines: string[] = [];
  for (const k of d.missing) {
    lines.push(
      `  MISSING  ${k} — the replay reached this leaf but the recording has ` +
        `no output for it (new phase, or a branch the recorded run skipped)`,
    );
  }
  for (const k of d.unused) {
    lines.push(
      `  UNUSED   ${k} — recorded, but the replay never reached it ` +
        `(phase removed, or now skipped by a \`when\` / branch change)`,
    );
  }
  if (d.reordered) {
    lines.push(
      `  REORDER  shared leaves executed in a different relative order`,
    );
  }
  return lines;
}
