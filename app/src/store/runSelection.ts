/**
 * runSelection — a one-shot "open THIS run" hand-off into the Runs page.
 *
 * Pages are mounted one at a time (App's renderPage switch), so a view that
 * links to a specific run (e.g. Notifications → "View") records the id here
 * and then navigates; RunsPage consumes it once as its initial selection.
 * Without it Runs opened on whichever run sorted first — a different run.
 * Deliberately tiny: a module-level slot, not context state, since nothing
 * needs to re-render when it is set.
 */

let requested: string | null = null;

/** Ask the next-mounted Runs page to open on the run with this id. */
export function requestRun(id: string): void {
  requested = id;
}

/** Take (and clear) the pending request — null when there is none. */
export function takeRequestedRun(): string | null {
  const id = requested;
  requested = null;
  return id;
}
