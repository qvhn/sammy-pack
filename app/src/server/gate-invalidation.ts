/**
 * gate-invalidation — compute which completed leaves a `request-changes`
 * gate decision must DROP from the replay cache so they genuinely re-run
 * (instead of replaying their stale captured output) when the run resumes.
 *
 * Background. A `lock: true` phase gates BEFORE it dispatches, so the
 * artifact a human reviews at the gate is the output of the work that ran
 * just before it. `request-changes` revises that work: we invalidate the
 * targeted leaves' replay cache, feed the human's feedback to the producing
 * phase, leave the lock ARMED (reArmLock) so the run re-pauses at the same
 * gate, and let everything else replay from cache (no wasted re-work).
 *
 * The trap this module fixes. The "reviewed artifact" is NOT always the
 * single last completed leaf. When the gate sits AFTER a refinement loop —
 * the ticket-to-PR shape `…→ implement-loop(implement → qa-verify) → review
 * → open-pr[lock]` — the last completed leaf is `review`, and the loop body's
 * leaves checkpointed under SCOPED keys (`implement-and-qa@1/implement`, …).
 * Invalidating only `review` lets `implement` + `qa-verify` REPLAY, so the
 * dev never re-implements with the feedback and `review` re-runs against the
 * same stale diff — producing the same verdict. The feedback is silently
 * dropped. So a request-changes at such a gate must invalidate the ENCLOSING
 * loop's most-recent iteration body PLUS everything completed after the loop
 * (review, a design gate, …) up to the gate — so the re-run re-implements,
 * re-verifies, and re-reviews against the revision, then re-pauses.
 *
 * Scope key grammar (see executor `replayScope` / `replayKeyFor`): a leaf's
 * replay key is `<scope>/<name>`; a top-level leaf has no scope (key ==
 * name); a loop body leaf one level deep is `<loopName>@<iter>/<name>`; nested
 * composites chain further (`outer@1/inner@2/leaf`). The `@<digits>` marker
 * uniquely identifies a loop-iteration scope.
 */

/** True if a replay key sits inside a loop iteration (carries an `@<n>`
 *  iteration marker anywhere in its scope chain). */
function isLoopScoped(key: string): boolean {
  return /(?:^|\/)[^/]+@\d+\//.test(key);
}

/** The loop-iteration prefix that ENCLOSES a leaf — the key truncated after
 *  its first `@<n>/` iteration marker, e.g. `implement-and-qa@1/implement` →
 *  `implement-and-qa@1/`, and `outer@2/inner@3/leaf` → `outer@2/`. We key off
 *  the OUTERMOST loop scope so request-changes re-runs the whole enclosing
 *  refinement pass (not just an inner sub-loop). Returns null for an
 *  unscoped (top-level) leaf. */
function enclosingLoopPrefix(key: string): string | null {
  const m = key.match(/^(.*?[^/]+@\d+\/)/);
  return m ? m[1] : null;
}

/**
 * Compute the set of completed-leaf replay keys to invalidate for a
 * `request-changes` decision at the gate the run is paused on.
 *
 * Cases:
 *  - No completed leaf → []  (caller treats this as "nothing to revise").
 *  - The last completed leaf is NOT after any loop (a plain pre-loop gate,
 *    e.g. the `plan` gate whose reviewed artifact is exactly the last leaf):
 *    invalidate just that leaf — unchanged from the original behavior.
 *  - The last completed leaf IS a loop body leaf, OR a loop body leaf
 *    precedes the trailing unscoped leaves (a post-loop gate): invalidate the
 *    ENTIRE enclosing loop (every iteration's body leaves), PLUS every leaf
 *    completed after the loop up to the gate. This makes the re-run actually
 *    re-implement + re-verify + re-review with the feedback, then (with
 *    reArmLock) re-pause once at the same gate — exactly one extra pass.
 *
 * Pure: derives everything from `completedLeaves` (in completion order) and
 * the scoped-key naming convention, so it needs no orchestration tree and is
 * trivially unit-testable.
 */
export function computeRequestChangesInvalidation(
  completedLeaves: readonly string[],
): string[] {
  if (completedLeaves.length === 0) return [];

  // Walk back from the gate over trailing UNSCOPED (top-level) leaves — these
  // are the phases that ran AFTER the loop but before the gate (review, a
  // design gate, …). The first loop-scoped leaf we hit marks the loop that
  // most recently produced work behind the gate.
  let i = completedLeaves.length - 1;
  const trailingUnscoped: string[] = [];
  while (i >= 0 && !isLoopScoped(completedLeaves[i])) {
    trailingUnscoped.push(completedLeaves[i]);
    i--;
  }

  // No loop-scoped leaf precedes the gate → a plain pre-loop gate. The
  // reviewed artifact is the single last completed leaf (original behavior).
  if (i < 0) {
    return [completedLeaves[completedLeaves.length - 1]];
  }

  // completedLeaves[i] is the last loop-body leaf behind the gate. Invalidate
  // the WHOLE enclosing loop — every completed leaf under its `<loop>@<n>/`
  // scope, across ALL iterations — so the loop genuinely re-runs from scratch
  // with the feedback rather than re-walking and replaying stale iterations.
  //
  // Why all iterations, not just the last: the executor's loop always re-walks
  // i=0..max and replays any iteration still in the cache. If we invalidated
  // only the last iteration, the earlier iterations would replay their STALE
  // (pre-feedback) implementation first and only the final pass would re-run —
  // muddying the refinement and risking a premature `until` match on stale
  // output. Dropping every iteration makes the resumed loop a clean re-run:
  // the dev re-implements with the feedback, QA re-verifies, and the loop
  // terminates normally (via `until` / maxIterations) — then review re-runs
  // and the armed lock re-pauses ONCE. That is the single extra
  // implement→qa→review→gate pass the gate contract promises (and it kills the
  // old failure mode where the dev never re-ran, so review kept returning the
  // same verdict and the human re-requested changes in an endless outer loop).
  const prefix = enclosingLoopPrefix(completedLeaves[i]);
  const invalidate = new Set<string>();
  if (prefix) {
    const loopBase = prefix.replace(/@\d+\/$/, '@'); // `implement-and-qa@`
    for (const key of completedLeaves) {
      // Any leaf whose OUTERMOST loop scope is this loop (any iteration).
      const ep = enclosingLoopPrefix(key);
      if (ep && ep.replace(/@\d+\/$/, '@') === loopBase) invalidate.add(key);
    }
  } else {
    // Defensive: couldn't parse a prefix — fall back to the single leaf.
    invalidate.add(completedLeaves[i]);
  }

  // Plus everything completed AFTER the loop, up to the gate (review etc.) —
  // they must re-evaluate the revision, not replay their stale verdicts.
  for (const key of trailingUnscoped) invalidate.add(key);

  // Return in completion order for a stable, legible result.
  return completedLeaves.filter(k => invalidate.has(k));
}

/**
 * The phase whose AGENT should receive the human's feedback as a gate
 * correction. The feedback is about the implementation, so it belongs to the
 * leaf the dev re-runs — the FIRST invalidated loop-body leaf (the
 * `implement` step), if any; otherwise the single reviewed leaf. Returns the
 * replay key; the caller maps it to the display phase name for `gateMessages`
 * (which the executor keys by `node.name`).
 */
export function feedbackTargetKey(
  invalidatedKeys: readonly string[],
  completedLeaves: readonly string[],
): string | null {
  if (invalidatedKeys.length === 0) {
    return completedLeaves.length > 0
      ? completedLeaves[completedLeaves.length - 1]
      : null;
  }
  // Prefer the first loop-body (implement) leaf among the invalidated set —
  // that's the producer the feedback is meant to steer.
  const firstLoopLeaf = invalidatedKeys.find(isLoopScoped);
  return firstLoopLeaf ?? invalidatedKeys[0];
}

/**
 * Lock phases that were ALREADY crossed (approved) in an earlier pass of a
 * run now paused at `pausedFor`, derived from the durable event log.
 *
 * Why this exists. A `lock` re-fires its gate every time the executor's walk
 * reaches it. When a run has more than one gate — the ticket-to-PR shape has
 * TWO: `implement-and-qa` (approve the plan) and `open-pr` (approve shipping)
 * — resuming from the LATER gate re-walks the tree from the top and hits the
 * EARLIER gate again. Unless that earlier, already-approved gate is
 * auto-approved on resume, the run re-pauses there and never reaches the work
 * (or the later gate) the human actually acted on — the run bounces between
 * gates forever. So a resume must auto-approve every lock crossed before the
 * current one, in addition to (per the caller's policy) the current
 * `pausedFor` itself.
 *
 * Derivation. Each crossing emits a `lock-gate` event carrying the gate's
 * iteration-SCOPED replay key (`replayKey`; equal to the bare phase name for a
 * top-level gate). The `pausedFor` ARG here is the CURRENT gate's scoped key
 * (the caller derives it from the last `lock-gate` event — the run's stored
 * `pausedFor` is the bare display name). So the LAST `lock-gate` is the current
 * gate; every DISTINCT other lock instance (by scoped key) that emitted a
 * `lock-gate` before it was crossed in a prior pass. We return those distinct
 * scoped keys (excluding the current gate's key). The executor consumes an
 * auto-approve entry once per matching hit (scoped-key first, bare-name
 * fallback).
 *
 * Keying by the scoped key — not the bare name — is what fixes a gate that
 * lives INSIDE a map/loop body and already ran multiple iterations: each
 * iteration's crossing has a distinct key (`…[0]/g`, `…[1]/g`, …), so every
 * already-crossed iteration is auto-approved on the re-walk and only the
 * genuinely-pending iteration (the current `pausedFor`) remains gated. With the
 * old name-only keying the earlier iterations collapsed onto one name that was
 * then excluded as the current `pausedFor`, so the re-walk re-paused at the
 * earlier iteration's gate — the serial-map resume→re-pause loop. Legacy
 * `lock-gate` events recorded before `replayKey` existed fall back to the bare
 * name (the prior behavior) via `replayKey ?? phaseName`.
 */
/**
 * Anti-retry-storm guard for a `request-changes` gate. Returns the terminal
 * reason when the phase the human's feedback would re-run has most recently
 * declared its failure TERMINAL (do-not-retry) — so the gate handler can REFUSE
 * to force a re-implementation of work the executor already flagged as pointless
 * to retry (a broken validator / dead infra). Null when no such terminal failure
 * stands — the overwhelming common case, so request-changes behaves exactly as
 * before.
 *
 * `targetPhaseName` is the DISPLAY name of the phase the feedback steers (the
 * caller derives it from `feedbackTargetKey` → the last matching `phase-end`).
 * We scan the event log for that phase: a `phase-terminal` for it counts ONLY if
 * it is not superseded by a later clean `phase-end` of the same phase (a re-run
 * that ultimately succeeded clears the terminal state). Pure — derives the
 * verdict from the durable events, so it's faithful and unit-testable.
 */
export function terminalFailureForGate(
  events: readonly {
    type?: string;
    phaseName?: string;
    reason?: string;
    error?: string;
  }[],
  targetPhaseName: string | null,
): string | null {
  if (!targetPhaseName) return null;
  // Walk newest→oldest; the FIRST relevant event for this phase decides:
  //  - a clean `phase-end` ⇒ the phase last succeeded ⇒ not terminal (null).
  //  - a `phase-terminal`  ⇒ the phase last failed terminally ⇒ return reason.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (typeof e?.phaseName !== 'string' || e.phaseName !== targetPhaseName) {
      continue;
    }
    if (e.type === 'phase-end') return null;
    if (e.type === 'phase-terminal') {
      return (
        (typeof e.reason === 'string' && e.reason) ||
        (typeof e.error === 'string' && e.error) ||
        'phase signalled a terminal (do-not-retry) failure'
      );
    }
  }
  return null;
}

export function priorCrossedLocks(
  events: readonly { type?: string; phaseName?: string; replayKey?: string }[],
  pausedFor: string | null,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  // Find the index of the LAST lock-gate (the current gate the run paused at)
  // so we only count crossings strictly before it.
  let lastGateIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'lock-gate') {
      lastGateIdx = i;
      break;
    }
  }
  for (let i = 0; i < events.length; i++) {
    if (i === lastGateIdx) continue; // the current (pending) gate
    const e = events[i];
    if (e?.type !== 'lock-gate' || typeof e.phaseName !== 'string') continue;
    // Key each crossing by its iteration-SCOPED replay key (the lock-gate event
    // carries it; equal to the bare phaseName for a top-level gate, and for
    // legacy events recorded before lock-gate carried replayKey). This is what
    // lets a gate repeated across map/loop iterations contribute a DISTINCT
    // auto-approve entry per iteration — `…[0]/implement-and-qa` and
    // `…[1]/implement-and-qa` no longer collapse to one bare name, so the
    // earlier iteration's already-crossed gate is auto-approved on the re-walk
    // instead of being excluded by the `pausedFor` (current gate) guard and
    // re-pausing the run. Compare against `pausedFor` (now also a scoped key)
    // by the SAME key so the current gate's own prior emissions are excluded.
    const key = e.replayKey ?? e.phaseName;
    if (pausedFor && key === pausedFor) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
  }
  return ordered;
}
