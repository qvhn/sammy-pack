/**
 * Attributable run-terminal process reaper.
 *
 * Problem: when a run is cancelled or reaches a terminal state, the SDK's
 * AbortController only kills the direct `claude` subprocess. Any grandchild
 * processes an agent spawned via a Bash tool (a headless Chrome, a sim driver,
 * a hung shell loop) are NOT killed — they orphan and linger for days, leaking
 * RAM (observed: 2-day-old `Chrome --print-to-pdf` survivors).
 *
 * Fix: at run terminal, walk the live process tree under THIS server process
 * and kill only the descendants that were spawned DURING the run (i.e. not in
 * the baseline captured at run start). This is:
 *   - attributable — only descendants of process.pid, spawned during the run;
 *   - safe — never kills the server (rootPid) or anything pre-existing;
 *     other Claude Code sessions / unrelated apps are NOT descendants of this
 *     server process, so they are never touched;
 *   - best-effort — every kill is guarded; ps failures no-op gracefully.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { forgetRunProcesses, runOfProcess } from './run-process-registry';

export { _resetRunProcessesForTests, registerRunProcess } from './run-process-registry';

const DEFAULT_GRACE_MS = 3000;

/** The run that owns `pid`: the owner of its nearest registered ancestor
 *  (the process itself included), walking up the `ppid` chain to `rootPid`. */
function ownerOf(pid: number, parentOf: Map<number, number>, rootPid: number): string | undefined {
  let cur: number | undefined = pid;
  const seen = new Set<number>();
  while (cur !== undefined && cur !== rootPid && !seen.has(cur)) {
    seen.add(cur);
    const owner = runOfProcess(cur);
    if (owner) return owner;
    cur = parentOf.get(cur);
  }
  return undefined;
}

/**
 * Read the full process table once (`ps -Ao pid=,ppid=`) and return all
 * transitive descendant PIDs of `rootPid` by walking the ppid→pid tree.
 * Pure, no side effects. On any failure (ps missing, parse error) returns
 * an empty set rather than throwing.
 */
export function descendantPids(rootPid: number): Set<number> {
  let table: string;
  try {
    table = readProcessTable();
  } catch (err) {
    console.warn(
      `[reap] could not read process table (descendants of ${rootPid} unknown):`,
      (err as Error)?.message ?? err,
    );
    return new Set<number>();
  }
  return descendantPidsFromTable(table, rootPid);
}

/**
 * Pure parse + tree-walk, split out so it is unit-testable without `ps`.
 * `table` is the raw `ps -Ao pid=,ppid=` output: one "<pid> <ppid>" per line.
 */
export function descendantPidsFromTable(
  table: string,
  rootPid: number,
): Set<number> {
  // ppid → [child pids]
  const children = new Map<number, number[]>();
  for (const line of table.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }

  const out = new Set<number>();
  // Iterative BFS so a deep tree can't blow the stack, and a cycle (which
  // can't really happen in a process table, but be defensive) terminates.
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const cur = queue.shift() as number;
    const kids = children.get(cur);
    if (!kids) continue;
    for (const kid of kids) {
      if (kid === rootPid || out.has(kid)) continue;
      out.add(kid);
      queue.push(kid);
    }
  }
  return out;
}

/**
 * Reap descendant processes that appeared during the run.
 *
 * Computes `current = descendantPids(rootPid)`, then targets
 * `current − baseline − {rootPid}` — the processes spawned DURING the run
 * that outlived it. SIGTERMs each target; after `graceMs` (default 3000ms)
 * SIGKILLs any still alive. Every kill is guarded (the process may already
 * be gone). NEVER kills rootPid or anything in `baseline`.
 *
 * Best-effort: any error is logged and swallowed; returns what it killed.
 */
export async function reapNewDescendants(
  rootPid: number,
  baseline: Set<number>,
  opts?: {
    graceMs?: number;
    /** The run being reaped. With it, a process owned by ANOTHER run (see
     *  registerRunProcess) is never a target. */
    runId?: string;
    /** Whether other runs are live in this process. Then a process no run
     *  claims is left alone too — it may be another run's. */
    otherRunsActive?: boolean;
  },
): Promise<{ killed: number[] }> {
  const graceMs = opts?.graceMs ?? DEFAULT_GRACE_MS;

  let current: Set<number>;
  let parentOf: Map<number, number>;
  try {
    const table = readProcessTable();
    current = descendantPidsFromTable(table, rootPid);
    parentOf = parentMapFromTable(table);
  } catch (err) {
    console.warn('[reap] descendant scan failed; nothing reaped:', err);
    return { killed: [] };
  }

  const targets: number[] = [];
  for (const pid of current) {
    if (pid === rootPid) continue;
    if (baseline.has(pid)) continue;
    if (opts?.runId !== undefined) {
      const owner = ownerOf(pid, parentOf, rootPid);
      if (owner !== undefined && owner !== opts.runId) continue;
      if (owner === undefined && opts.otherRunsActive) continue;
    }
    targets.push(pid);
  }
  if (opts?.runId !== undefined) forgetRunProcesses(opts.runId);
  if (targets.length === 0) return { killed: [] };

  // Phase 1 — polite SIGTERM. Track which ones we actually signalled (a
  // process that's already gone throws ESRCH; nothing to reap there).
  const signalled: number[] = [];
  for (const pid of targets) {
    if (trySignal(pid, 'SIGTERM')) signalled.push(pid);
  }

  if (signalled.length === 0) return { killed: [] };

  // Give them a moment to exit on their own.
  await sleep(graceMs);

  // Phase 2 — SIGKILL anything still alive. signal 0 is a liveness probe.
  const killed: number[] = [];
  for (const pid of signalled) {
    if (isAlive(pid)) {
      trySignal(pid, 'SIGKILL');
    }
    // It's "killed by us" whether SIGTERM or SIGKILL did the job — we
    // signalled it and it's a run-attributable orphan.
    killed.push(pid);
  }
  return { killed };
}

/** pid → ppid from a `ps -Ao pid=,ppid=` table. */
export function parentMapFromTable(table: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of table.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) out.set(pid, ppid);
  }
  return out;
}

/** Send `signal` to `pid`, swallowing the "already gone" case. Returns true
 *  if the signal was accepted (process existed). */
function trySignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    // ESRCH (gone) or EPERM (not ours — shouldn't happen for descendants):
    // either way, don't throw.
    return false;
  }
}

/** Liveness probe via signal 0. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Read the full process table once. We read it with a blocking call so
 *  descendantPids() can stay synchronous (callers want a cheap snapshot).
 *  `ps -Ao pid=,ppid=` => all procs, no header, two columns; the `=`
 *  suffixes suppress the column headers. */
function readProcessTable(): string {
  return execFileSync('ps', ['-Ao', 'pid=,ppid='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Stop every process whose working directory lies inside one of `dirs` (a
 * finished run's worktrees). A dev server an agent started with `&` is
 * re-parented to init when the agent's shell exits, so the descendant scan
 * above never sees it — but it is still running inside the run's worktree,
 * which nothing else uses. SIGTERM, then SIGKILL after `graceMs`. Never this
 * process. Best-effort: an unreadable process table reaps nothing.
 * Linux reads /proc/<pid>/cwd; macOS asks `lsof`; elsewhere it is a no-op.
 */
export async function reapProcessesUnder(
  dirs: string[],
  opts?: { graceMs?: number },
): Promise<{ killed: number[] }> {
  if (dirs.length === 0) return { killed: [] };
  const roots = dirs.map(d => {
    try {
      return realpathSync(d);
    } catch {
      return d;
    }
  });
  const inside = (cwd: string) => roots.some(r => cwd === r || cwd.startsWith(r.endsWith('/') ? r : `${r}/`));
  const targets: number[] = [];
  for (const [pid, cwd] of processCwds()) {
    if (pid !== process.pid && inside(cwd)) targets.push(pid);
  }
  const signalled = targets.filter(pid => trySignal(pid, 'SIGTERM'));
  if (signalled.length === 0) return { killed: [] };
  await sleep(opts?.graceMs ?? DEFAULT_GRACE_MS);
  for (const pid of signalled) if (isAlive(pid)) trySignal(pid, 'SIGKILL');
  return { killed: signalled };
}

/** pid → working directory, for the processes this user can see. */
function processCwds(): Map<number, string> {
  const out = new Map<number, string>();
  try {
    if (process.platform === 'linux') {
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          out.set(Number(entry), readlinkSync(`/proc/${entry}/cwd`));
        } catch {
          /* gone, or not ours */
        }
      }
    } else if (process.platform === 'darwin') {
      // -F pn: one "p<pid>" line then one "n<path>" line per process.
      // lsof exits 1 when some processes cannot be inspected; its output for
      // the rest is still valid, so keep it.
      let text: string;
      try {
        text = execFileSync('lsof', ['-a', '-d', 'cwd', '-F', 'pn'], {
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch (err) {
        text = String((err as { stdout?: unknown }).stdout ?? '');
      }
      let pid: number | null = null;
      for (const line of text.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1));
        else if (line.startsWith('n') && pid !== null) out.set(pid, line.slice(1));
      }
    }
  } catch {
    /* lsof missing / exited non-zero with partial output: use what we have */
  }
  return out;
}
