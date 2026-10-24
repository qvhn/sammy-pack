/**
 * Repository URL → local clone: the lookup a `worktrees` entry falls back to
 * when given a web address, and the /api/repos routes the Run dialog uses to
 * find a clone or offer one.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  getJson,
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
import { cloneRepo, findLocalClone, normalizeRepoUrl } from '../src/server/repo-locate';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('normalizeRepoUrl', () => {
  it('gives one key for every spelling of a repository', () => {
    const want = 'github.com/acme/web';
    for (const u of [
      'https://github.com/acme/web',
      'https://github.com/acme/web.git',
      'https://github.com/Acme/Web/',
      'git@github.com:acme/web.git',
      'ssh://git@github.com/acme/web.git',
    ]) {
      expect(normalizeRepoUrl(u)).toBe(want);
    }
  });

  it('rejects what is not a repository on a host', () => {
    for (const u of [
      '/Users/me/web',
      'https://github.com/acme',
      'file:///tmp/x',
      'not a url',
      'http://github.com/acme/web',
      'git@evil.example:owner/..\\..\\Startup',
      'ssh://evil.example/o/..',
      'https://github.com/acme/..',
    ]) {
      expect(normalizeRepoUrl(u)).toBeNull();
    }
  });
});

describe('repository URL → local clone', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let reposDir: string;
  let clone: string;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await fs.realpath(await makeWorkspace('repo-locate'));
    reposDir = path.join(tmpRoot, 'repos');
    clone = path.join(reposDir, 'web');
    await fs.mkdir(clone, { recursive: true });
    git(clone, 'init', '-q', '-b', 'main');
    await fs.writeFile(path.join(clone, 'README.md'), '# web\n');
    git(clone, 'add', '.');
    git(clone, '-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    git(clone, 'remote', 'add', 'origin', 'https://github.com/acme/web.git');
    process.env.SAMMY_REPO_ROOTS = reposDir;
    await writeOrchestration(tmpRoot, {
      name: 'wt-from-url',
      vars: { repo: 'git@github.com:acme/web.git' },
      worktrees: [{ name: 'r', repo: '${repo}' }],
      phases: [{ name: 'where', code: { source: "return state.worktrees.r.repo.split('/').pop()" } }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'wt-from-unknown-url',
      vars: { repo: 'https://github.com/acme/elsewhere' },
      worktrees: [{ name: 'r', repo: '${repo}' }],
      phases: [{ name: 'where', code: { source: 'return "unreachable"' } }],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    restoreEnv();
  });

  const settled = (id: string) =>
    waitFor(async () => {
      const r = await getRun(mount.baseUrl, id);
      return r.status === 'done' || r.status === 'error' ? r : null;
    }, 'settled', { timeoutMs: 25_000, intervalMs: 100 });

  it('finds the clone whose origin matches, in any URL spelling', async () => {
    expect(await findLocalClone('https://github.com/acme/web', [reposDir])).toBe(clone);
    expect(await findLocalClone('https://github.com/acme/other', [reposDir])).toBeNull();
  });

  it('GET /api/repos/locate answers with the clone, or where one would go', async () => {
    const found = await getJson<{ local: string | null; cloneTo: string | null }>(
      `${mount.baseUrl}/api/repos/locate?url=${encodeURIComponent('git@github.com:acme/web.git')}`,
    );
    expect(found).toMatchObject({ local: clone, cloneTo: null });
    const missing = await getJson<{ local: string | null; cloneTo: string | null }>(
      `${mount.baseUrl}/api/repos/locate?url=${encodeURIComponent('https://github.com/acme/tool')}`,
    );
    expect(missing).toMatchObject({ local: null, cloneTo: path.join(reposDir, 'tool') });
  });

  it('refuses a local path or junk as a URL', async () => {
    const res = await fetch(`${mount.baseUrl}/api/repos/locate?url=${encodeURIComponent('/tmp/web')}`);
    expect(res.status).toBe(400);
    const { status } = await postJson(`${mount.baseUrl}/api/repos/clone`, { url: 'nope' });
    expect(status).toBe(400);
  });

  it('POST /api/repos/clone returns the existing clone instead of cloning again', async () => {
    const { status, body } = await postJson<{ local: string }>(`${mount.baseUrl}/api/repos/clone`, {
      url: 'https://github.com/acme/web',
    });
    expect(status).toBe(200);
    expect(body.local).toBe(clone);
  });

  it('a worktree given a URL runs in the matching local clone', async () => {
    const run = await settled((await startRun(mount.baseUrl, 'wt-from-url')).id!);
    expect(run.status).toBe('done');
    // The repo's folder name (a full temp path reads as a token to the scrubber).
    expect(String(run.lastOutput)).toBe('web');
  });

  it('a worktree given a URL with no clone says what to do', async () => {
    const run = await settled((await startRun(mount.baseUrl, 'wt-from-unknown-url')).id!);
    expect(run.status).toBe('error');
    expect(JSON.stringify(run.events)).toMatch(
      /repo \\"https:\/\/github.com\/acme\/elsewhere\\" is a URL with no local clone under .*clone it first, or start the run from the Run dialog/,
    );
  });

  it('cloneRepo clones, and will not overwrite an existing directory', async () => {
    const bare = path.join(tmpRoot, 'upstream.git');
    git(tmpRoot, 'clone', '-q', '--bare', clone, bare);
    const dest = path.join(tmpRoot, 'fresh');
    await cloneRepo(bare, dest);
    expect(git(dest, 'log', '--format=%s', '-1')).toBe('init');
    await expect(cloneRepo(bare, dest)).rejects.toThrow(/already exists/);
  });

  it('cloneRepo gives the clone the configured identity', async () => {
    const bare = path.join(tmpRoot, 'upstream-id.git');
    git(tmpRoot, 'clone', '-q', '--bare', clone, bare);
    const dest = path.join(tmpRoot, 'with-identity');
    process.env.SAMMY_GIT_USER_NAME = 'demo-bot';
    process.env.SAMMY_GIT_USER_EMAIL = 'demo-bot@example.test';
    try {
      await cloneRepo(bare, dest);
    } finally {
      delete process.env.SAMMY_GIT_USER_NAME;
      delete process.env.SAMMY_GIT_USER_EMAIL;
    }
    expect(git(dest, 'config', '--local', 'user.name')).toBe('demo-bot');
    expect(git(dest, 'config', '--local', 'user.email')).toBe('demo-bot@example.test');
  });
});

describe('/api/repos/clone behind SAMMY_API_TOKEN', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await fs.realpath(await makeWorkspace('repo-locate-auth'));
    process.env.SAMMY_REPO_ROOTS = tmpRoot;
    process.env.SAMMY_API_TOKEN = 'test-token';
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    restoreEnv();
  });

  it('refuses a clone without the bearer', async () => {
    const { status } = await postJson(`${mount.baseUrl}/api/repos/clone`, {
      url: 'https://github.com/acme/web',
    });
    expect(status).toBe(401);
  });
});
