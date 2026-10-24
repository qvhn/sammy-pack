/**
 * The per-run figure on the Runs page card vs. what the budget charges.
 *
 * A failed attempt never reaches its phase-end; its spend rides on the
 * phase-error, and the server (`sumCostUsd`, the caps, the mid-run gate)
 * folds BOTH events. The card's `totalUsage` folded phase-ends only, so a
 * run with retries showed less than the 402 it was refused with or the
 * figure in Settings → Cost guardrails. Mirrors `sumCostUsd`: phase-end +
 * phase-error, and a composite's re-emitted failure (no cost) adds nothing.
 *
 * The definition itself now lives in `lib/spend` (see
 * `spend-definition.test.ts`) — `/api/cost` and `/api/observability` still
 * fold `phase-end` alone, so the card and those digests disagree by what the
 * failed attempts spent.
 */

import { foldSpend } from '../src/lib/spend';
import { totalUsage, type Run } from '../src/store/runs';

function run(events: Run['events']): Run {
  return {
    id: 'r1',
    orchestrationName: 'orch',
    startedAt: 0,
    status: 'error',
    events,
    eventVersion: events.length,
  };
}

const phaseEnd = (phaseName: string, costUsd: number): Run['events'][number] => ({
  type: 'phase-end',
  phaseName,
  output: '',
  inputTokens: 100,
  outputTokens: 10,
  costUsd,
  durationMs: 1000,
  model: 'm',
  ts: 1,
});

describe('totalUsage — charges failed attempts like the server does', () => {
  it('sums phase-end AND phase-error costUsd, matching run-store sumCostUsd', () => {
    const events: Run['events'] = [
      { type: 'run-start', ts: 0 } as Run['events'][number],
      { type: 'phase-start', phaseName: 'build', ts: 1 } as Run['events'][number],
      // The attempt that failed: no phase-end, spend on the phase-error.
      {
        type: 'phase-error',
        phaseName: 'build',
        error: 'boom',
        costUsd: 0.02,
        inputTokens: 50,
        outputTokens: 5,
        ts: 2,
      },
      // The composite re-emitting that failure carries no cost — must not
      // double-count.
      { type: 'phase-error', phaseName: 'pipeline', error: 'boom', ts: 3 },
      // The retry that succeeded.
      phaseEnd('build', 0.01),
    ];
    const usage = totalUsage(run(events));
    expect(usage.costUsd).toBeCloseTo(0.03, 10);
    expect(usage.input).toBe(150);
    expect(usage.output).toBe(15);
    expect(usage.durationMs).toBe(1000);
  });

  it('is unchanged for a run with no failures', () => {
    const usage = totalUsage(run([phaseEnd('a', 0.01), phaseEnd('b', 0.02)]));
    expect(usage.costUsd).toBeCloseTo(0.03, 10);
    expect(usage.input).toBe(200);
  });

  it('renders an absent token figure as absent, not NaN', () => {
    // `sammy-cli run-phase <id> <phase> end` mirrors an externally-driven
    // run with a phase-end that carries no token fields, and the ingest
    // validator deliberately permits that (it refuses only a present
    // non-finite or negative figure). Reading them as numbers printed
    // "in NaNt / out NaNt" on the card while every server-side fold
    // reported 0.
    const cliEnd = {
      type: 'phase-end',
      phaseName: 'p',
      output: 'x',
      ts: 1,
    } as unknown as Run['events'][number];
    const usage = totalUsage(run([cliEnd]));
    expect(usage.input).toBe(0);
    expect(usage.output).toBe(0);
    expect(usage.costUsd).toBe(0);
    expect(Number.isNaN(usage.input)).toBe(false);
    expect(Number.isNaN(usage.output)).toBe(false);
  });

  it('is the shared spend definition, not a second copy of it', () => {
    // The card had its own fold, which is how four readers moved onto
    // phase-end + phase-error and two were left behind.
    const events: Run['events'] = [
      phaseEnd('a', 0.01),
      {
        type: 'phase-error',
        phaseName: 'a',
        error: 'boom',
        costUsd: 0.02,
        inputTokens: 50,
        outputTokens: 5,
        ts: 2,
      },
    ];
    const usage = totalUsage(run(events));
    const shared = foldSpend(events);
    expect(usage.input).toBe(shared.inputTokens);
    expect(usage.output).toBe(shared.outputTokens);
    expect(usage.costUsd).toBe(shared.costUsd);
  });
});
