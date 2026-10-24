/**
 * ONE definition of what a run spent.
 *
 * Six hand-rolled folds over one event stream drifted apart: the caps
 * (`db.ts`, `postgres-store.ts`), `sumCostUsd`, the mid-run gate and the Runs
 * card count `phase-end` + `phase-error`, while the `/api/cost` and
 * `/api/observability` folds counted `phase-end` alone — so the same run
 * reported two different costs depending on which surface was asked, and the
 * gap was exactly what the retried attempts spent. `lib/spend` is the one
 * place the answer lives.
 *
 * Pinned in BOTH directions, because both are ways to get it wrong: drop
 * `phase-error` and a retry storm reports $0; charge every event and the
 * cumulative `cost` event double-counts the whole run.
 */

import { addSpend, emptySpend, foldSpend, isSpendEvent } from '../src/lib/spend';

const PHASE_END = {
  type: 'phase-end',
  phaseName: 'build',
  inputTokens: 1000,
  outputTokens: 500,
  costUsd: 0.01,
};
const PHASE_ERROR = {
  type: 'phase-error',
  phaseName: 'build',
  error: 'boom',
  inputTokens: 1000,
  outputTokens: 500,
  costUsd: 0.01,
};

describe('the spend definition', () => {
  it('charges a completed phase AND a failed attempt', () => {
    expect(foldSpend([PHASE_END])).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.01,
    });
    // One phase, two attempts: the first failed and charged on its
    // phase-error, the second succeeded. This is the figure the caps charge
    // and the 402 an operator reconciles against.
    const twoAttempts = foldSpend([PHASE_ERROR, PHASE_END]);
    expect(twoAttempts.inputTokens).toBe(2000);
    expect(twoAttempts.outputTokens).toBe(1000);
    expect(twoAttempts.costUsd).toBeCloseTo(0.02, 10);
    // Retry exhaustion — every attempt failed. A phase-end-only fold calls
    // this run free.
    const exhausted = foldSpend([PHASE_ERROR, PHASE_ERROR, PHASE_ERROR]);
    expect(exhausted.costUsd).toBeCloseTo(0.03, 10);
    expect(exhausted.inputTokens).toBe(3000);
  });

  it('charges NOTHING for any other event, including the cumulative `cost`', () => {
    // `cost` is a running total of the whole run; folding it in would
    // double-count. `run-end` carries no figures at all.
    expect(isSpendEvent({ type: 'cost' })).toBe(false);
    expect(isSpendEvent({ type: 'phase-start' })).toBe(false);
    expect(isSpendEvent({ type: 'run-end' })).toBe(false);
    expect(isSpendEvent(PHASE_END)).toBe(true);
    expect(isSpendEvent(PHASE_ERROR)).toBe(true);
    expect(
      foldSpend([
        { type: 'run-start' },
        { type: 'phase-start' },
        { type: 'cost', costUsd: 99, inputTokens: 99, outputTokens: 99 },
        { type: 'text-delta', costUsd: 5 },
        { type: 'run-end' },
      ]),
    ).toEqual(emptySpend());
  });

  it('reads an absent, non-numeric or non-finite figure as 0, never as NaN', () => {
    // The repo's own CLI mirrors a run with a phase-end that carries no
    // token fields, and the ingest validator permits it. Propagating that
    // printed "in NaNt / out NaNt" on the run card.
    const totals = foldSpend([
      { type: 'phase-end' },
      { type: 'phase-error', costUsd: Number.NaN },
      { type: 'phase-end', inputTokens: Infinity, costUsd: '0.5' },
      PHASE_END,
    ]);
    expect(totals).toEqual({ inputTokens: 1000, outputTokens: 500, costUsd: 0.01 });
    expect(Number.isFinite(totals.inputTokens)).toBe(true);
    expect(Number.isFinite(totals.costUsd)).toBe(true);
  });

  it('folds in place so a caller can share a loop it already walks', () => {
    const totals = emptySpend();
    for (const e of [PHASE_END, { type: 'cost', costUsd: 99 }, PHASE_ERROR]) {
      addSpend(totals, e);
    }
    expect(totals.costUsd).toBeCloseTo(0.02, 10);
    expect(totals.inputTokens).toBe(2000);
  });
});
