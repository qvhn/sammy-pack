/**
 * THE definition of what a run's event stream says it spent.
 *
 * A leaf's `phase-end` carries the tokens and USD of that one call. A
 * leaf's own `phase-error` carries what its FAILED attempt spent — a failed
 * attempt never reaches a `phase-end`, and `retry` then pays again, so
 * folding phase-ends alone hides a retry storm. Every surface charges
 * both: the budget caps (`db.ts`, `postgres-store.ts`, in SQL), `sumCostUsd`
 * (`run-store.ts`), the mid-run gate, the Runs card (`store/runs.tsx`, via
 * `addSpend`), `/api/cost` and `/api/observability`. That is six folds over
 * one event stream, which is why the answer lives here once: a change
 * cannot move four of them and leave two behind, letting one retried run
 * report two different costs depending on which page is open.
 * `__tests__/spend-surfaces-agree.test.ts` pins the agreement across the
 * surfaces.
 *
 * Deliberately free of imports and of any event type: the server routes walk
 * `StoredEvent`, the browser store walks `RunEvent`, and the structural
 * shape below is the intersection both satisfy.
 *
 * A missing figure counts as 0 rather than propagating: the repo's own CLI
 * (`sammy-cli run-phase <id> <phase> end`) mirrors a run with a `phase-end`
 * that carries no token fields, and the validator deliberately permits it —
 * reading those as numbers would print "in NaNt / out NaNt" on the run card.
 */

/** The fields of an event this fold reads. Anything else passes through.
 *  `type` is optional because several server-side row shapes declare it so
 *  (a stored event read back from either store); an event with no type
 *  carries no spend, which is what the fold already concludes. */
export type SpendEvent = {
  type?: string;
  inputTokens?: unknown;
  outputTokens?: unknown;
  costUsd?: unknown;
};

export type SpendTotals = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

/** Does this event carry spend? The one answer to "which events count". */
export function isSpendEvent(e: { type?: string }): boolean {
  return e.type === 'phase-end' || e.type === 'phase-error';
}

export function emptySpend(): SpendTotals {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

/** A figure as money/tokens, or 0 — absent, non-numeric and non-finite all
 *  read as "this event reported nothing", never as NaN. */
function figure(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Fold one event into a running total, in place. A no-op for every event
 *  that carries no spend, so a caller can pass its whole stream through a
 *  single loop it is already walking for other reasons. */
export function addSpend(into: SpendTotals, e: SpendEvent): void {
  if (!isSpendEvent(e)) return;
  into.inputTokens += figure(e.inputTokens);
  into.outputTokens += figure(e.outputTokens);
  into.costUsd += figure(e.costUsd);
}

/** Fold a whole event stream. O(events), pure. */
export function foldSpend(events: Iterable<SpendEvent>): SpendTotals {
  const totals = emptySpend();
  for (const e of events) addSpend(totals, e);
  return totals;
}
