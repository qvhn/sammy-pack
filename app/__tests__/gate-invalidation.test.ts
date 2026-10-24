/**
 * Unit tests for the gate-invalidation helpers that fix the
 * request-changes / post-loop-gate replay bug.
 */
import {
  computeRequestChangesInvalidation,
  feedbackTargetKey,
  priorCrossedLocks,
} from '../src/server/gate-invalidation';

describe('computeRequestChangesInvalidation', () => {
  test('no completed leaves → empty', () => {
    expect(computeRequestChangesInvalidation([])).toEqual([]);
  });

  test('plain pre-loop gate: only the single last (reviewed) leaf', () => {
    // e.g. the `plan` gate: spec → design → [plan gate]. The reviewed
    // artifact IS the last completed leaf — unchanged behavior.
    expect(computeRequestChangesInvalidation(['spec', 'design'])).toEqual([
      'design',
    ]);
  });

  test('post-loop gate: enclosing loop body (one iteration) + trailing leaves', () => {
    // The ticket-to-PR ship gate shape. Last completed leaf is `review`, but
    // the implementation is in the loop body — invalidate BOTH so the dev
    // re-implements and review re-evaluates.
    const completed = [
      'implement-and-qa@1/implement',
      'implement-and-qa@1/qa-verify',
      'review',
    ];
    expect(computeRequestChangesInvalidation(completed)).toEqual(completed);
  });

  test('post-loop gate: ALL iterations of the enclosing loop are invalidated', () => {
    // A loop that ran 3 iterations on the first pass: every iteration's body
    // is dropped so the resumed loop re-runs cleanly (no stale replay).
    const completed = [
      'implement-and-qa@1/implement',
      'implement-and-qa@1/qa-verify',
      'implement-and-qa@2/implement',
      'implement-and-qa@2/qa-verify',
      'implement-and-qa@3/implement',
      'implement-and-qa@3/qa-verify',
      'review',
    ];
    expect(computeRequestChangesInvalidation(completed)).toEqual(completed);
  });

  test('multiple trailing post-loop leaves (design-gate + review) both invalidated', () => {
    const completed = [
      'loopA@1/implement',
      'loopA@1/qa',
      'design-gate',
      'review',
    ];
    expect(computeRequestChangesInvalidation(completed)).toEqual(completed);
  });

  test('pre-loop leaves (read-ticket, plan) are NOT invalidated — only the enclosing loop forward', () => {
    // Upstream work before the loop must still replay (never redone).
    const completed = [
      'read-ticket',
      'plan',
      'implement-and-qa@1/implement',
      'implement-and-qa@1/qa-verify',
      'review',
    ];
    expect(computeRequestChangesInvalidation(completed)).toEqual([
      'implement-and-qa@1/implement',
      'implement-and-qa@1/qa-verify',
      'review',
    ]);
  });

  test('the gate immediately after the loop (no trailing leaf) invalidates the loop body', () => {
    // open-pr gates right after the loop, no review in between.
    const completed = [
      'implement-and-qa@1/implement',
      'implement-and-qa@1/qa-verify',
    ];
    expect(computeRequestChangesInvalidation(completed)).toEqual(completed);
  });

  test('a sibling loop earlier in the run is not dragged in', () => {
    // Only the loop the gate sits behind is re-run; an unrelated earlier loop
    // and its trailing leaf stay cached.
    const completed = [
      'early-loop@1/x',
      'plan',
      'impl-loop@1/implement',
      'impl-loop@1/qa',
      'review',
    ];
    expect(computeRequestChangesInvalidation(completed)).toEqual([
      'impl-loop@1/implement',
      'impl-loop@1/qa',
      'review',
    ]);
  });
});

describe('feedbackTargetKey', () => {
  test('routes to the first loop-body (implement) leaf when present', () => {
    const inv = [
      'implement-and-qa@1/implement',
      'implement-and-qa@1/qa-verify',
      'review',
    ];
    expect(feedbackTargetKey(inv, inv)).toBe('implement-and-qa@1/implement');
  });

  test('routes to the single reviewed leaf for a plain pre-loop gate', () => {
    expect(feedbackTargetKey(['design'], ['spec', 'design'])).toBe('design');
  });

  test('falls back to the last completed leaf when nothing was invalidated', () => {
    expect(feedbackTargetKey([], ['spec', 'design'])).toBe('design');
  });
});

describe('priorCrossedLocks', () => {
  test('derives an earlier gate when paused at a later one', () => {
    const events = [
      { type: 'lock-gate', phaseName: 'implement-and-qa' },
      { type: 'phase-end', phaseName: 'implement' },
      { type: 'lock-gate', phaseName: 'open-pr' },
    ];
    expect(priorCrossedLocks(events, 'open-pr')).toEqual(['implement-and-qa']);
  });

  test('excludes the current pausedFor gate (the last lock-gate)', () => {
    const events = [
      { type: 'lock-gate', phaseName: 'g1' },
      { type: 'lock-gate', phaseName: 'g2' },
    ];
    expect(priorCrossedLocks(events, 'g2')).toEqual(['g1']);
  });

  test('a single-gate run has no prior locks', () => {
    const events = [{ type: 'lock-gate', phaseName: 'open-pr' }];
    expect(priorCrossedLocks(events, 'open-pr')).toEqual([]);
  });

  test('dedupes a gate that fired more than once before the current one', () => {
    // A loop-body gate that re-fired across iterations collapses to one name.
    const events = [
      { type: 'lock-gate', phaseName: 'plan-gate' },
      { type: 'lock-gate', phaseName: 'plan-gate' },
      { type: 'lock-gate', phaseName: 'open-pr' },
    ];
    expect(priorCrossedLocks(events, 'open-pr')).toEqual(['plan-gate']);
  });

  test('no lock-gate events → empty', () => {
    expect(priorCrossedLocks([{ type: 'phase-end', phaseName: 'x' }], null)).toEqual([]);
  });
});
