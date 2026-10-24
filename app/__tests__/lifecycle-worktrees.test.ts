/**
 * Root `worktrees` through real runs: the run's commands execute INSIDE its
 * own worktree (cwd + SAMMY_WORKTREE_<NAME> + ${worktrees.<name>.path}), a
 * leg resumed past a gate finds the same worktree again, and the terminal
 * applies the cleanup policy — removed on success, kept on error.
 */

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  approveGate,
  getRun,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  postJson,
  startRun,
  waitFor,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(60_000);

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('lifecycle: worktrees', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let repo: string;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_ALLOW_CODE_RUN = '1';
    tmpRoot = await fs.realpath(await makeWorkspace('worktrees'));
    repo = path.join(tmpRoot, 'target-repo');
    await fs.mkdir(repo);
    git(repo, 'init', '-q', '-b', 'main');
    await fs.writeFile(path.join(repo, 'README'), 'hello\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    await writeOrchestration(tmpRoot, {
      name: 'wt-ok',
      worktrees: [{ name: 'app', repo: 'target-repo', branch: 'fix/${input.fp}' }],
      phases: [
        // Compared in the shell: a raw temp path in the OUTPUT trips the
        // secret scrubber's high-entropy pattern (the random tmpdir name).
        {
          name: 'where',
          code: {
            run:
              '[ "$(pwd -P)" = "$(cd "$SAMMY_WORKTREE_APP" && pwd -P)" ] && echo cwd-is-worktree; ' +
              'git rev-parse --abbrev-ref HEAD; cat README',
          },
          as: 'where',
        },
        { name: 'gate', lock: true, code: { source: 'return state.worktrees.app.branch;' } },
        { name: 'again', code: { run: '[ "$(pwd -P)" = "$(cd "$SAMMY_WORKTREE_APP" && pwd -P)" ] && echo still-in-worktree' } },
      ],
    });
    await writeOrchestration(tmpRoot, {
      name: 'wt-fail',
      worktrees: [{ name: 'app', repo: 'target-repo' }],
      phases: [{ name: 'boom', code: { run: 'exit 3' } }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'wt-edit',
      worktrees: [{ name: 'app', repo: 'target-repo', branch: 'edit/${input.k}' }],
      phases: [
        { name: 'edit', code: { run: 'touch edited.txt' } },
        { name: 'check', code: { run: 'ls edited.txt' } },
        { name: 'gate', lock: true, code: { source: "return 'ok';" } },
      ],
    });
    await writeOrchestration(tmpRoot, {
      name: 'wt-retry',
      worktrees: [{ name: 'app', repo: 'target-repo', branch: 'retry/${input.k}' }],
      phases: [{ name: 'maybe', code: { run: 'sh -c "test ! -f FAIL_ONCE || (rm -f FAIL_ONCE; exit 1)"' } }],
    });
    await writeOrchestration(tmpRoot, {
      // A step that backgrounds a long-lived process (a dev server, say) and
      // exits: the process is re-parented away from the server.
      name: 'wt-leftover',
      worktrees: [{ name: 'app', repo: 'target-repo' }],
      phases: [{ name: 'serve', code: { run: "sh -c 'sleep 120 >/dev/null 2>&1 & echo $!'" }, as: 'pid' }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'wt-bad-repo',
      worktrees: [{ name: 'app', repo: 'no-such-repo' }],
      phases: [{ name: 'never', code: { source: "return 'ran';" } }],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    // A run's worktree cleanup finishes just after its status turns terminal,
    // so git may still be writing under tmpRoot — retry ENOTEMPTY.
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    restoreEnv();
  });

  const finished = (id: string, status: string) =>
    waitFor(async () => {
      const r = await getRun(mount.baseUrl, id);
      return r.status === status ? r : null;
    }, `run ${status}`);

  it('runs inside its worktree, reuses it across a gate, and removes it on success', async () => {
    const id = (await startRun(mount.baseUrl, 'wt-ok', JSON.stringify({ fp: 'abc' }))).id!;
    const paused = await finished(id, 'paused');
    const expectedPath = path.join(tmpRoot, '.worktrees', 'wt-ok', id, 'app');
    const lines = String(paused.stateJson?.leafOutputs?.where ?? '').trim().split('\n');
    expect(lines).toEqual(['cwd-is-worktree', 'fix/abc', 'hello']);
    expect(git(expectedPath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('fix/abc');
    const ready = paused.events.filter(e => e.type === 'worktrees-ready');
    expect(ready).toHaveLength(1);
    expect(ready[0].worktrees).toEqual([
      expect.objectContaining({ name: 'app', path: expectedPath, branch: 'fix/abc', reused: false }),
    ]);

    await approveGate(mount.baseUrl, id);
    const done = await finished(id, 'done');
    const readies = done.events.filter(e => e.type === 'worktrees-ready');
    expect(readies).toHaveLength(2);
    expect((readies[1].worktrees as Array<{ reused: boolean }>)[0].reused).toBe(true);
    expect(String(done.lastOutput).trim()).toBe('still-in-worktree');

    await waitFor(
      async () =>
        (await fs.access(expectedPath).then(() => false).catch(() => true)) ? true : null,
      'worktree removed',
    );
    // The branch had no commits beyond its base, so it goes too (right after
    // the worktree — the same cleanup step, asynchronously).
    await waitFor(
      async () => (git(repo, 'branch', '--list', 'fix/abc') === '' ? true : null),
      'empty branch deleted',
    );
  });

  it('stops a process left running in the worktree when the run ends', async () => {
    const run = await finished((await startRun(mount.baseUrl, 'wt-leftover')).id!, 'done');
    const pid = Number(String(run.lastOutput).trim());
    expect(pid).toBeGreaterThan(0);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await waitFor(async () => (alive() ? null : true), 'leftover stopped', { timeoutMs: 10_000, intervalMs: 100 });
    } finally {
      if (alive()) process.kill(pid, 'SIGKILL');
    }
  });

  it('keeps the worktree when the run errors', async () => {
    const id = (await startRun(mount.baseUrl, 'wt-fail')).id!;
    await finished(id, 'error');
    const p = path.join(tmpRoot, '.worktrees', 'wt-fail', id, 'app');
    await new Promise(r => setTimeout(r, 300));
    await expect(fs.access(p)).resolves.toBeUndefined();
  });

  it('refuses a fork past a step whose edits lived in the old worktree', async () => {
    const id = (await startRun(mount.baseUrl, 'wt-edit', JSON.stringify({ k: 'f1' }))).id!;
    await finished(id, 'paused');
    const fork = await postJson<{ id: string }>(`${mount.baseUrl}/api/runs/${id}/fork`, { atPhase: 'check' });
    expect(fork.status).toBe(200);
    const forked = await finished(fork.body.id, 'error');
    expect(JSON.stringify(forked.events)).toMatch(/replays earlier phases/);
  });

  it('cleans up the worktree when a run paused at a gate is cancelled', async () => {
    const id = (await startRun(mount.baseUrl, 'wt-edit', JSON.stringify({ k: 'c1' }))).id!;
    await finished(id, 'paused');
    const p = path.join(tmpRoot, '.worktrees', 'wt-edit', id, 'app');
    await expect(fs.access(p)).resolves.toBeUndefined();
    expect((await postJson(`${mount.baseUrl}/api/runs/${id}/cancel`)).status).toBe(200);
    await waitFor(async () => ((await fs.access(p).then(() => false).catch(() => true)) ? true : null), 'removed');
  });

  it('lets a later run for the same key take the branch an errored run kept', async () => {
    // First run: a marker makes the step fail; its worktree is KEPT (error).
    await fs.writeFile(path.join(repo, 'FAIL_ONCE'), '');
    git(repo, 'add', 'FAIL_ONCE');
    git(repo, '-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'marker');
    const first = (await startRun(mount.baseUrl, 'wt-retry', JSON.stringify({ k: 'r1' }))).id!;
    await finished(first, 'error');
    const keptPath = path.join(tmpRoot, '.worktrees', 'wt-retry', first, 'app');
    await expect(fs.access(keptPath)).resolves.toBeUndefined();
    // The kept tree let go of the branch, so a second attempt can continue it
    // (the marker was deleted in the first tree, but the second checks the
    // branch out fresh — and the branch never committed the deletion).
    git(repo, 'rm', '-q', 'FAIL_ONCE');
    git(repo, '-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'unmark');
    const second = (await startRun(mount.baseUrl, 'wt-retry', JSON.stringify({ k: 'r1' }))).id!;
    const run = await waitFor(async () => {
      const r = await getRun(mount.baseUrl, second);
      return r.status === 'done' || r.status === 'error' ? r : null;
    }, 'second settled');
    expect(JSON.stringify(run.events)).not.toMatch(/already used by worktree/);
  });

  it('fails the run with git\'s reason when the repo is wrong', async () => {
    const id = (await startRun(mount.baseUrl, 'wt-bad-repo')).id!;
    const run = await finished(id, 'error');
    expect(JSON.stringify(run.events)).toMatch(/not a git repository/);
    expect(JSON.stringify(run.events)).not.toContain('"ran"');
  });
});
