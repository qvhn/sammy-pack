/**
 * Which run started which top-level process (an agent's `claude` CLI, a
 * direct child of this server). Written where agents are spawned
 * (sdk-stream), read by the run-terminal reaper (reap.ts) so a run never
 * kills another run's processes.
 *
 * Deliberately free of Node imports: sdk-stream is reachable from the
 * browser bundle through the executor, and a `node:` import there blanks
 * the web app.
 */
const owners = new Map<number, string>();

/** Owner recorded for the server's own helper processes (a clone the Run
 *  dialog asked for, a worktree's git command): never any run's to reap. */
export const SERVER_OWNER = '(server)';

export function registerRunProcess(runId: string, pid: number): void {
  owners.set(pid, runId);
}

export function runOfProcess(pid: number): string | undefined {
  return owners.get(pid);
}

export function forgetProcess(pid: number): void {
  owners.delete(pid);
}

export function forgetRunProcesses(runId: string): void {
  for (const [pid, owner] of owners) if (owner === runId) owners.delete(pid);
}

/** Test seam: forget every registration. */
export function _resetRunProcessesForTests(): void {
  owners.clear();
}
