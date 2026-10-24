/**
 * Isolated git worktrees per run — the root `worktrees` block.
 *
 * An automation that changes code needs a working tree of its own: a person's
 * checkout must not be edited underneath them, and two runs must not edit the
 * same files at once. For each declared entry this module checks a fresh
 * worktree of a LOCAL repository out on its own branch before the run starts,
 * and removes it when the run ends.
 *
 *   ensureWorktrees  — create (or, on a resumed leg, find again) every
 *                      declared worktree. Idempotent per run id.
 *   cleanupWorktrees — apply each entry's `cleanup` policy at the run's
 *                      terminal status.
 *
 * Layout: `<SAMMY_WORKTREE_DIR or <root>/.worktrees>/<orchestration>/<run id>/
 * <name>`, with a `<name>.sammy.json` record beside it holding what cleanup
 * needs (the repository, the branch, the commit it started from, and whether
 * this run created the branch). A branch is only ever deleted when THIS run
 * created it and it carries no commits beyond its start point — work that was
 * committed (and perhaps pushed for review) is never thrown away.
 *
 * Every git call is `execFile` with an argument list — no shell — so a branch
 * name derived from an inbound payload cannot inject a command.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { interpolate } from '../llm/interpolate';
import type { WorktreeDecl } from '../types';
import { validateWorktrees } from '../intake-options';
import { findLocalClone, isRepoUrl, repoSearchRoots } from './repo-locate';
import { forgetProcess, registerRunProcess, SERVER_OWNER } from './run-process-registry';
import { reapProcessesUnder } from './reap';

export { validateWorktrees };

export type PreparedWorktree = {
  name: string;
  repo: string;
  path: string;
  branch: string;
  /** The commit the branch started from (sha). */
  base: string;
  /** True when this leg found an existing worktree (a resumed run). */
  reused: boolean;
};

type Record_ = {
  repo: string;
  branch: string;
  baseSha: string;
  createdBranch: boolean;
  /** False between writing the record and `git worktree add` finishing —
   *  the record goes first, so a crash in that window is recoverable. */
  ready?: boolean;
};

const GIT_TIMEOUT_MS = 120_000;

function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (child.pid !== undefined) forgetProcess(child.pid);
        if (err) {
          const detail = (stderr || stdout || err.message).toString().trim();
          reject(new Error(`git ${args.join(' ')} failed: ${detail}`));
        } else {
          resolve(stdout.toString().trim());
        }
      },
    );
    // Server-owned: a run ending meanwhile must not reap it (reap.ts).
    if (child.pid !== undefined) registerRunProcess(SERVER_OWNER, child.pid);
  });
}

export function worktreeRoot(root: string): string {
  const env = process.env.SAMMY_WORKTREE_DIR?.trim();
  return env ? path.resolve(root, env) : path.join(root, '.worktrees');
}

/** Path-safe segment: anything outside [A-Za-z0-9._-] becomes '-'. */
function segment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'x';
}

export function worktreePaths(root: string, orchestration: string, runId: string, name: string) {
  const dir = path.join(worktreeRoot(root), segment(orchestration), segment(runId));
  return { dir, path: path.join(dir, name), record: path.join(dir, `${name}.sammy.json`) };
}

/**
 * Render a branch template and coerce it into a valid ref name. Characters git
 * forbids become '-', so a payload value can shape the name but not break it.
 */
export function renderBranch(
  template: string | undefined,
  vars: { runId: string; orchestration: string; initialInput: string; name?: string },
): string {
  // The default is SHORT on purpose — `sammy/<run suffix>-<worktree>` — and
  // names the worktree, since two entries on one repository must not share a
  // branch (git refuses to check one branch out twice). A long default
  // (orchestration + full run id) read as a 40+ character token to the output
  // scrubber, so the branch name was redacted wherever a run printed it.
  const t = template ?? 'sammy/${run.short}-${worktree.name}';
  const unresolved: string[] = [];
  const raw = interpolate(
    t,
    {
      run: { id: vars.runId, short: vars.runId.split('-').pop() || vars.runId },
      orchestration: vars.orchestration,
      input: vars.initialInput,
      worktree: { name: vars.name ?? 'wt' },
    },
    ref => unresolved.push(ref),
  );
  if (unresolved.length > 0) {
    throw new Error(
      `worktree branch "${t}" has unresolved reference(s): ${unresolved.join(', ')}`,
    );
  }
  const cleaned = raw
    .split('/')
    .map(part =>
      part
        // eslint-disable-next-line no-control-regex -- git forbids control chars in refs
        .replace(/[\s~^:?*[\\\x00-\x1f\x7f]+/g, '-')
        .replace(/\.{2,}/g, '.')
        .replace(/@\{/g, '-')
        .replace(/^[.-]+|[.]+$/g, '')
        .replace(/\.lock$/i, '-lock'),
    )
    .filter(Boolean)
    .join('/');
  if (!cleaned) throw new Error(`worktree branch "${t}" renders to an empty name`);
  return cleaned.slice(0, 200);
}

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * Create every declared worktree for this run, or find the ones a previous leg
 * of the SAME run created (resume after a gate or a restart). Rolls back the
 * worktrees it created itself if a later entry fails, so a half-prepared run
 * leaves nothing behind.
 */
export async function ensureWorktrees(
  decls: WorktreeDecl[],
  opts: {
    root: string;
    runId: string;
    orchestration: string;
    initialInput: string;
    /** This leg REPLAYS earlier phases (a resume, a fork): their file edits
     *  exist only in the worktree an earlier leg of this run made, so a
     *  missing one cannot be recreated from `base` — that would silently run
     *  the remaining phases on an unedited tree. Fail instead. */
    mustExist?: boolean;
    /** Values `repo` / `base` may reference as `${name}`: the orchestration's
     *  `vars` and the run's declared `inputs` — operator-supplied, never the
     *  trigger payload (a payload must not choose which repository a run
     *  checks out). */
    vars?: Record<string, unknown>;
  },
): Promise<PreparedWorktree[]> {
  const problems = validateWorktrees(decls);
  if (problems.length > 0) throw new Error(`invalid worktrees: ${problems.join('; ')}`);
  // `${name}` in repo / base resolves against vars + declared inputs only —
  // and only when a worktree is CREATED: a resumed leg finds its record and
  // never needs them (its inputs may not even be threaded back in).
  const render = (d: WorktreeDecl, field: 'repo' | 'base', t: string | undefined) => {
    if (t === undefined || !t.includes('${')) return t;
    const missing: string[] = [];
    const out = interpolate(t, opts.vars ?? {}, ref => missing.push(ref));
    if (missing.length > 0 || out.trim() === '') {
      throw new Error(
        `worktree "${d.name}": ${field} "${t}" needs ${missing.map(m => '${' + m + '}').join(', ') || 'a value'} ` +
          '— set it in the orchestration vars or as a run input',
      );
    }
    return out;
  };
  // Two entries on one repository rendering to one branch would make the
  // second checkout fail half-way; say so before touching anything.
  const claimed = new Map<string, string>();
  for (const d of decls) {
    const key = `${path.resolve(opts.root, d.repo)}\u0000${renderBranch(d.branch, {
      runId: opts.runId,
      orchestration: opts.orchestration,
      initialInput: opts.initialInput,
      name: d.name,
    })}`;
    const prior = claimed.get(key);
    if (prior) {
      throw new Error(
        `worktrees "${prior}" and "${d.name}" would check out the same branch of the same ` +
          'repository — give one of them a different `branch`',
      );
    }
    claimed.set(key, d.name);
  }
  const out: PreparedWorktree[] = [];
  const createdNow: Array<{ repo: string; path: string; branch: string; createdBranch: boolean }> = [];
  try {
    for (const d of decls) {
      const p = worktreePaths(opts.root, opts.orchestration, opts.runId, d.name);
      if (await exists(p.record)) {
        const rec = JSON.parse(await fs.readFile(p.record, 'utf8')) as Record_;
        const there = await exists(p.path);
        if (rec.ready === false) {
          // A previous leg crashed between writing the record and the
          // checkout finishing: finish it now.
          if (!there) {
            const branchNow = await git(['show-ref', '--verify', '--quiet', `refs/heads/${rec.branch}`], rec.repo)
              .then(() => true)
              .catch(() => false);
            await git(
              branchNow
                ? ['worktree', 'add', p.path, rec.branch]
                : ['worktree', 'add', '-b', rec.branch, p.path, rec.baseSha],
              rec.repo,
            );
          }
          rec.ready = true;
          await fs.writeFile(p.record, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
        } else if (!there) {
          throw new Error(
            `worktree "${d.name}" for run ${opts.runId} was removed from ${p.path} — ` +
              'the edits this run made there are gone, so it cannot be resumed; start a new run',
          );
        }
        // A worktree kept after an error is DETACHED (so its branch is free
        // for another run); resuming this run takes the branch back.
        const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], p.path).catch(() => '');
        if (head !== rec.branch) {
          await git(['checkout', rec.branch], p.path).catch(err => {
            throw new Error(
              `worktree "${d.name}": cannot take branch ${rec.branch} back to resume this run — ` +
                `${(err as Error).message}`,
            );
          });
        }
        out.push({ name: d.name, repo: rec.repo, path: p.path, branch: rec.branch, base: rec.baseSha, reused: true });
        continue;
      }
      if (opts.mustExist) {
        throw new Error(
          `worktree "${d.name}": this leg replays earlier phases of the run, but their ` +
            'worktree does not exist here (a fork gets a new one, and a removed one cannot be ' +
            'rebuilt) — the replayed edits would be missing. Start a new run instead.',
        );
      }
      let given = render(d, 'repo', d.repo)!;
      // The repository's web address instead of a clone's path is a common
      // slip. Use this machine's clone of it when there is one; otherwise say
      // so (path.resolve would mangle the URL into a nonsense local path).
      if (isRepoUrl(given)) {
        const roots = await repoSearchRoots(opts.root);
        const clone = await findLocalClone(given, roots);
        if (!clone) {
          throw new Error(
            `worktree "${d.name}": repo "${given}" is a URL with no local clone under ` +
              `${roots.join(', ') || '(no search roots)'} — clone it first, or start the run ` +
              'from the Run dialog, which offers to',
          );
        }
        given = clone;
      }
      const repo = path.resolve(opts.root, given);
      const baseRef = render(d, 'base', d.base);
      await git(['rev-parse', '--git-dir'], repo).catch(() => {
        throw new Error(`worktree "${d.name}": ${repo} is not a git repository`);
      });
      const branch = renderBranch(d.branch, {
        runId: opts.runId,
        orchestration: opts.orchestration,
        initialInput: opts.initialInput,
        name: d.name,
      });
      await git(['check-ref-format', '--branch', branch], repo).catch(() => {
        throw new Error(`worktree "${d.name}": "${branch}" is not a valid branch name`);
      });
      const baseSha = await git(['rev-parse', '--verify', `${baseRef ?? 'HEAD'}^{commit}`], repo).catch(
        () => {
          throw new Error(`worktree "${d.name}": base "${baseRef ?? 'HEAD'}" is not a commit in ${repo}`);
        },
      );
      const branchExists = await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repo)
        .then(() => true)
        .catch(() => false);
      await fs.mkdir(p.dir, { recursive: true });
      const rec: Record_ = { repo, branch, baseSha, createdBranch: !branchExists, ready: false };
      await fs.writeFile(p.record, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
      if (branchExists) {
        // Continue an existing branch (e.g. a second attempt at the same
        // fix). git refuses if it is checked out in another worktree, which
        // is the right answer: two runs must not share one.
        await git(['worktree', 'add', p.path, branch], repo);
      } else {
        await git(['worktree', 'add', '-b', branch, p.path, baseSha], repo);
      }
      createdNow.push({ repo, path: p.path, branch, createdBranch: !branchExists });
      rec.ready = true;
      await fs.writeFile(p.record, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
      out.push({ name: d.name, repo, path: p.path, branch, base: baseSha, reused: false });
    }
  } catch (err) {
    // Records written for checkouts that never completed in THIS call.
    for (const d of decls) {
      const p = worktreePaths(opts.root, opts.orchestration, opts.runId, d.name);
      if (!createdNow.some(c => c.path === p.path) && !out.some(o => o.path === p.path && o.reused)) {
        const rec = await fs.readFile(p.record, 'utf8').then(r => JSON.parse(r) as Record_).catch(() => null);
        if (rec && rec.ready === false && !(await exists(p.path))) await fs.rm(p.record, { force: true });
      }
    }
    for (const c of createdNow.reverse()) {
      await removeWorktree(c.repo, c.path, c.branch, c.createdBranch, null).catch(() => {});
      await fs.rm(`${c.path}.sammy.json`, { force: true }).catch(() => {});
    }
    throw err;
  }
  return out;
}

async function removeWorktree(
  repo: string,
  wtPath: string,
  branch: string,
  createdBranch: boolean,
  baseSha: string | null,
): Promise<{ branchDeleted: boolean }> {
  await git(['worktree', 'remove', '--force', wtPath], repo).catch(async () => {
    // Already gone from disk: let git forget it.
    await fs.rm(wtPath, { recursive: true, force: true });
    await git(['worktree', 'prune'], repo).catch(() => {});
  });
  if (!createdBranch) return { branchDeleted: false };
  const ahead = baseSha
    ? Number(await git(['rev-list', '--count', `${baseSha}..refs/heads/${branch}`], repo).catch(() => '1'))
    : 0;
  if (ahead === 0) {
    await git(['branch', '-D', branch], repo).catch(() => {});
    return { branchDeleted: true };
  }
  return { branchDeleted: false };
}

export type CleanupOutcome = {
  name: string;
  path: string;
  action: 'removed' | 'kept';
  branch: string;
  branchDeleted: boolean;
  reason?: string;
};

/**
 * Apply each entry's `cleanup` policy at the run's terminal status. Only
 * `done` / `error` / `cancelled` are terminal here — a paused or interrupted
 * run keeps its worktrees, since it may yet be resumed. Never throws: a
 * cleanup problem is reported, not raised into run finalization.
 */
export async function cleanupWorktrees(
  decls: WorktreeDecl[] | undefined,
  opts: { root: string; runId: string; orchestration: string; status: string },
): Promise<CleanupOutcome[]> {
  if (!decls || decls.length === 0) return [];
  if (!['done', 'error', 'cancelled'].includes(opts.status)) return [];
  const out: CleanupOutcome[] = [];
  for (const d of decls) {
    const p = worktreePaths(opts.root, opts.orchestration, opts.runId, d.name);
    let rec: Record_;
    try {
      rec = JSON.parse(await fs.readFile(p.record, 'utf8')) as Record_;
    } catch {
      continue; // never created (the run failed before, or no record)
    }
    // Anything still running inside the worktree outlived its run (a dev
    // server an agent backgrounded is re-parented away from this server, so
    // the run's descendant reap never sees it). Stop it whether the worktree
    // is kept or removed.
    await reapProcessesUnder([p.path], { graceMs: 1500 }).catch(() => ({ killed: [] }));
    const policy = d.cleanup ?? 'remove';
    const remove =
      policy === 'always-remove' || (policy === 'remove' && opts.status !== 'error');
    if (!remove) {
      // Kept for inspection — but DETACHED, so its branch is not held: a
      // later run for the same key (`fix/${input.fp}`) can check the branch
      // out, and nothing committed is lost (the branch still points at it).
      await git(['checkout', '--detach'], p.path).catch(() => {});
      out.push({
        name: d.name,
        path: p.path,
        action: 'kept',
        branch: rec.branch,
        branchDeleted: false,
        reason: policy === 'keep' ? 'cleanup: keep' : `run ended ${opts.status} — kept for inspection`,
      });
      continue;
    }
    try {
      const { branchDeleted } = await removeWorktree(
        rec.repo,
        p.path,
        rec.branch,
        rec.createdBranch,
        rec.baseSha,
      );
      await fs.rm(p.record, { force: true });
      out.push({ name: d.name, path: p.path, action: 'removed', branch: rec.branch, branchDeleted });
    } catch (err) {
      out.push({
        name: d.name,
        path: p.path,
        action: 'kept',
        branch: rec.branch,
        branchDeleted: false,
        reason: `removal failed: ${(err as Error).message}`,
      });
    }
  }
  // Drop the now-empty run directory (and its orchestration dir if empty).
  const runDir = worktreePaths(opts.root, opts.orchestration, opts.runId, 'x').dir;
  await fs.rmdir(runDir).catch(() => {});
  await fs.rmdir(path.dirname(runDir)).catch(() => {});
  return out;
}

/** Env var name for a worktree's path: SAMMY_WORKTREE_<NAME>. */
export function worktreeEnvName(name: string): string {
  return `SAMMY_WORKTREE_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}
