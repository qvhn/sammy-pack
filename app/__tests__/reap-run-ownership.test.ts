/**
 * A run reaping its leftovers must not kill another run's processes. Before
 * ownership, a run that paused or finished SIGTERMed the agents of every run
 * started after it ("Claude Code process exited with code 143" mid-step).
 * Real processes: `sleep` children of this test process stand in for agents.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _resetRunProcessesForTests,
  descendantPids,
  reapNewDescendants,
  reapProcessesUnder,
  registerRunProcess,
} from '../src/server/reap';
import { SERVER_OWNER } from '../src/server/run-process-registry';

const alive = (p: ChildProcess) => {
  try {
    process.kill(p.pid!, 0);
    return true;
  } catch {
    return false;
  }
};
const sleeper = () => spawn('sleep', ['30'], { stdio: 'ignore' });

describe('reapNewDescendants with run ownership', () => {
  let kids: ChildProcess[] = [];
  afterEach(() => {
    for (const k of kids) if (alive(k)) k.kill('SIGKILL');
    kids = [];
    _resetRunProcessesForTests();
  });

  it("kills its own run's processes and leaves another live run's alone", async () => {
    const baseline = descendantPids(process.pid);
    const mine = sleeper();
    const theirs = sleeper();
    const unowned = sleeper();
    kids = [mine, theirs, unowned];
    registerRunProcess('run-a', mine.pid!);
    registerRunProcess('run-b', theirs.pid!);
    const { killed } = await reapNewDescendants(process.pid, baseline, {
      graceMs: 200,
      runId: 'run-a',
      otherRunsActive: true,
    });
    expect(killed).toContain(mine.pid);
    expect(killed).not.toContain(theirs.pid);
    expect(killed).not.toContain(unowned.pid); // may be run-b's: left alone
    expect(alive(theirs)).toBe(true);
    expect(alive(unowned)).toBe(true);
  });

  it("never reaps the server's own helper processes", async () => {
    const baseline = descendantPids(process.pid);
    const helper = sleeper();
    kids = [helper];
    registerRunProcess(SERVER_OWNER, helper.pid!);
    const { killed } = await reapNewDescendants(process.pid, baseline, {
      graceMs: 200,
      runId: 'run-a',
      otherRunsActive: false,
    });
    expect(killed).not.toContain(helper.pid);
    expect(alive(helper)).toBe(true);
  });

  it('reaps an unowned leftover when no other run is live', async () => {
    const baseline = descendantPids(process.pid);
    const unowned = sleeper();
    kids = [unowned];
    const { killed } = await reapNewDescendants(process.pid, baseline, {
      graceMs: 200,
      runId: 'run-a',
      otherRunsActive: false,
    });
    expect(killed).toContain(unowned.pid);
  });
});

describe('reapProcessesUnder — leftovers re-parented away from the server', () => {
  it('stops a process running inside the directory, and only that one', async () => {
    const inside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sammy-wt-')));
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sammy-other-')));
    // `sh -c 'sleep 30 & ...'` + exit: the sleep is re-parented to init —
    // exactly the backgrounded dev server the descendant scan misses.
    const spawnDetached = (cwd: string) =>
      Number(execFileSync('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { cwd, encoding: 'utf8' }).trim());
    const a = spawnDetached(inside);
    const b = spawnDetached(outside);
    const isUp = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      expect(isUp(a) && isUp(b)).toBe(true);
      const { killed } = await reapProcessesUnder([inside], { graceMs: 200 });
      expect(killed).toContain(a);
      expect(killed).not.toContain(b);
      await new Promise(r => setTimeout(r, 300));
      expect(isUp(a)).toBe(false);
      expect(isUp(b)).toBe(true);
    } finally {
      for (const pid of [a, b]) if (isUp(pid)) process.kill(pid, 'SIGKILL');
    }
  });
});
