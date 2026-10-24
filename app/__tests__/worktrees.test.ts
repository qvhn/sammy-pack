import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupWorktrees,
  ensureWorktrees,
  renderBranch,
  validateWorktrees,
  worktreePaths,
} from '../src/server/worktrees';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;
let repo: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-wt-')));
  repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.test');
  git(repo, 'config', 'user.name', 't');
  await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'init');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const base = { runId: 'run-1', orchestration: 'fixer', initialInput: '{"fingerprint":"ab12"}' };

describe('ensureWorktrees', () => {
  it('creates a worktree on a new branch from HEAD, and finds it again on resume', async () => {
    const decls = [{ name: 'app', repo: 'repo', branch: 'fix/${input.fingerprint}' }];
    const [wt] = await ensureWorktrees(decls, { root, ...base });
    expect(wt).toMatchObject({ name: 'app', branch: 'fix/ab12', reused: false });
    expect(wt.path).toBe(worktreePaths(root, 'fixer', 'run-1', 'app').path);
    expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('fix/ab12');
    expect(wt.base).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(await fs.readFile(path.join(wt.path, 'a.txt'), 'utf8')).toBe('a\n');

    const [again] = await ensureWorktrees(decls, { root, ...base });
    expect(again).toMatchObject({ path: wt.path, branch: 'fix/ab12', reused: true });
  });

  it('continues an existing branch instead of failing', async () => {
    git(repo, 'branch', 'fix/ab12');
    const [wt] = await ensureWorktrees([{ name: 'app', repo, branch: 'fix/${input.fingerprint}' }], {
      root,
      ...base,
    });
    expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('fix/ab12');
    // Not ours → never deleted by cleanup.
    const [out] = await cleanupWorktrees([{ name: 'app', repo }], { root, ...base, status: 'done' });
    expect(out).toMatchObject({ action: 'removed', branchDeleted: false });
    expect(git(repo, 'branch', '--list', 'fix/ab12')).toContain('fix/ab12');
  });

  it('rolls back the worktrees it created when a later entry fails', async () => {
    await expect(
      ensureWorktrees(
        [
          { name: 'one', repo },
          { name: 'two', repo: path.join(root, 'not-a-repo') },
        ],
        { root, ...base },
      ),
    ).rejects.toThrow(/not a git repository/);
    expect(git(repo, 'worktree', 'list')).not.toContain('run-1');
    expect(git(repo, 'branch', '--list', 'sammy/*')).toBe('');
  });

  it('refuses an unknown base and unresolved branch refs', async () => {
    await expect(ensureWorktrees([{ name: 'a', repo, base: 'nope' }], { root, ...base })).rejects.toThrow(
      /base "nope" is not a commit/,
    );
    await expect(
      ensureWorktrees([{ name: 'a', repo, branch: 'x/${input.missing}' }], { root, ...base }),
    ).rejects.toThrow(/unresolved reference/);
  });
});

describe('cleanupWorktrees', () => {
  it('removes on done and deletes a branch with no commits', async () => {
    const [wt] = await ensureWorktrees([{ name: 'app', repo }], { root, ...base });
    const [out] = await cleanupWorktrees([{ name: 'app', repo }], { root, ...base, status: 'done' });
    expect(out).toMatchObject({ action: 'removed', branchDeleted: true });
    await expect(fs.access(wt.path)).rejects.toThrow();
    expect(git(repo, 'branch', '--list', wt.branch)).toBe('');
  });

  it('keeps a branch that has commits, even when the worktree is removed', async () => {
    const [wt] = await ensureWorktrees([{ name: 'app', repo }], { root, ...base });
    await fs.writeFile(path.join(wt.path, 'b.txt'), 'b\n');
    git(wt.path, 'add', 'b.txt');
    git(wt.path, '-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'fix');
    const [out] = await cleanupWorktrees([{ name: 'app', repo }], { root, ...base, status: 'cancelled' });
    expect(out).toMatchObject({ action: 'removed', branchDeleted: false });
    expect(git(repo, 'branch', '--list', wt.branch)).toContain(wt.branch);
  });

  it('keeps the worktree on error by default; always-remove and keep do what they say', async () => {
    await ensureWorktrees(
      [
        { name: 'dflt', repo },
        { name: 'gone', repo, cleanup: 'always-remove' as const },
        { name: 'stay', repo, cleanup: 'keep' as const },
      ],
      { root, ...base },
    );
    const outs = await cleanupWorktrees(
      [
        { name: 'dflt', repo },
        { name: 'gone', repo, cleanup: 'always-remove' },
        { name: 'stay', repo, cleanup: 'keep' },
      ],
      { root, ...base, status: 'error' },
    );
    expect(outs.map(o => [o.name, o.action])).toEqual([
      ['dflt', 'kept'],
      ['gone', 'removed'],
      ['stay', 'kept'],
    ]);
  });

  it('refuses two entries that would share a branch of one repository', async () => {
    await expect(
      ensureWorktrees(
        [
          { name: 'a', repo, branch: 'same' },
          { name: 'b', repo, branch: 'same' },
        ],
        { root, ...base },
      ),
    ).rejects.toThrow(/would check out the same branch/);
  });

  it('does nothing for a paused run', async () => {
    await ensureWorktrees([{ name: 'app', repo }], { root, ...base });
    expect(await cleanupWorktrees([{ name: 'app', repo }], { root, ...base, status: 'paused' })).toEqual([]);
  });
});

describe('renderBranch / validateWorktrees', () => {
  it('coerces hostile input into a valid ref', () => {
    const b = renderBranch('fix/${input.t}', {
      runId: 'r',
      orchestration: 'o',
      initialInput: JSON.stringify({ t: 'a b..c~d^e:f?g*h[i\\j@{k} --x.lock' }),
    });
    expect(b).not.toMatch(/[\s~^:?*[\\]|\.\.|@\{/);
    expect(b.startsWith('fix/')).toBe(true);
    expect(
      renderBranch(undefined, { runId: 'run-1792945705076-ij2x55', orchestration: 'o', initialInput: '', name: 'app' }),
    ).toBe('sammy/ij2x55-app');
  });

  it('names bad declarations', () => {
    expect(validateWorktrees([{ name: 'app', repo: '.' }])).toEqual([]);
    const p = validateWorktrees([
      { name: '9x', repo: '' },
      { name: 'a', repo: '.', cleanup: 'sometimes', extra: 1 },
      { name: 'A', repo: '.' },
    ]).join('\n');
    expect(p).toMatch(/name must start with a letter/);
    expect(p).toMatch(/repo is required/);
    expect(p).toMatch(/cleanup must be/);
    expect(p).toMatch(/extra is not a known option/);
    expect(p).toMatch(/"A" is declared twice/);
  });
});

describe('ensureWorktrees — repo from vars / run inputs', () => {
  it('resolves ${name} in repo and base against the operator-supplied vars', async () => {
    const [wt] = await ensureWorktrees([{ name: 'app', repo: '${repo}', base: '${baseRef}' }], {
      root,
      ...base,
      vars: { repo, baseRef: 'main' },
    });
    expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(wt.branch);
    expect(wt.repo).toBe(repo);
  });

  it('names the missing value when repo cannot be resolved', async () => {
    await expect(
      ensureWorktrees([{ name: 'app', repo: '${repo}' }], { root, ...base, vars: {} }),
    ).rejects.toThrow(/repo "\$\{repo\}" needs \$\{repo\} — set it in the orchestration vars or as a run input/);
  });
});

describe('ensureWorktrees — a URL with no local clone', () => {
  // Search an empty directory, not this machine's ~/git.
  let saved: string | undefined;
  beforeAll(async () => {
    saved = process.env.SAMMY_REPO_ROOTS;
    process.env.SAMMY_REPO_ROOTS = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-no-clones-'));
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.SAMMY_REPO_ROOTS;
    else process.env.SAMMY_REPO_ROOTS = saved;
  });
  it.each(['https://github.com/acme/web', 'git@github.com:acme/web.git'])(
    'names the mistake for %s',
    async url => {
      await expect(
        ensureWorktrees([{ name: 'app', repo: '${repo}' }], { root, ...base, vars: { repo: url } }),
      ).rejects.toThrow(`repo "${url}" is a URL with no local clone under`);
    },
  );
});
