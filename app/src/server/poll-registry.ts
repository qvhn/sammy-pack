/**
 * Process-global registry of live polling timers.
 *
 * WHY THIS EXISTS: trigger registration keeps its polling tasks in a map
 * owned by the MOUNT's closure (`pollTasksByOrch`). That is enough to stop
 * them when an orchestration is re-saved — but not when the server is
 * re-mounted inside one process, which is exactly what a vite dev restart or
 * an HMR reload does. The new mount's closure cannot see the previous
 * mount's map, so the old pollers keep running: invisible, unstoppable, and
 * each one still fetching its source and delivering. Every reload adds
 * another, so one URL ends up polled N times.
 *
 * Cron already had this fixed, deliberately, after a leak that pegged a
 * laptop: node-cron keeps a PROCESS-GLOBAL task registry, so registration
 * gives each task a deterministic name (`sammy:cron:<orch>:<expr>`) and
 * destroys any pre-existing task with that name before scheduling. Polling
 * had no equivalent registry, so it had no equivalent fix. This module is
 * that registry — same shape, same deterministic naming, so the two kinds
 * behave alike.
 *
 * Module scope is the point: it must outlive any single mount.
 */

/** Live pollers by deterministic name. Module-level ON PURPOSE — mount-scoped
 *  state is precisely what failed to contain the leak. */
const pollers = new Map<string, () => void>();

/** `sammy:poll:<orch>:<source>` — deterministic, so a re-mount registering
 *  the same trigger collides with (and therefore replaces) its predecessor
 *  instead of adding to it. */
export function pollTaskName(orchName: string, source: string): string {
  return `sammy:poll:${orchName}:${source}`;
}

/** Register a poller, first stopping any existing one with the same name.
 *  Registration is therefore idempotent across the whole process. */
export function registerPoller(name: string, stop: () => void): void {
  destroyPoller(name);
  pollers.set(name, stop);
}

/** Stop + forget one poller. Safe when absent or already stopped. */
export function destroyPoller(name: string): void {
  const stop = pollers.get(name);
  pollers.delete(name);
  if (!stop) return;
  try {
    stop();
  } catch {
    /* already stopped */
  }
}

/** Stop every poller belonging to one orchestration — the re-save path.
 *  Returns the names stopped (for logging). */
export function destroyPollersFor(orchName: string): string[] {
  const prefix = `sammy:poll:${orchName}:`;
  const hit = [...pollers.keys()].filter(n => n.startsWith(prefix));
  for (const n of hit) destroyPoller(n);
  return hit;
}

/** Stop every poller in the process — mount shutdown, and the seam a test
 *  uses to guarantee no timer outlives it. */
export function destroyAllPollers(): string[] {
  const all = [...pollers.keys()];
  for (const n of all) destroyPoller(n);
  return all;
}

/** Names of the live pollers, for introspection and assertions. */
export function livePollerNames(): string[] {
  return [...pollers.keys()];
}
