/**
 * The Run dialog's folder picker: listing the folders in one directory
 * (dir-browse.ts) and the GET /api/repos/browse route that serves it to
 * requests from the server's own machine only.
 */
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { makeWorkspace, mountServer, pinTestEnv, type Mount } from './lifecycle-harness.helpers';
import { BrowseError, listDirs } from '../src/server/dir-browse';

async function tree(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'repos', 'web', '.git'), { recursive: true });
  await fs.mkdir(path.join(root, 'repos', 'Api'), { recursive: true });
  await fs.writeFile(path.join(root, 'repos', 'Api', '.git'), 'gitdir: elsewhere\n');
  await fs.mkdir(path.join(root, 'repos', 'notes'), { recursive: true });
  await fs.mkdir(path.join(root, 'repos', '.cache'), { recursive: true });
  await fs.writeFile(path.join(root, 'repos', 'README.md'), 'a file, not a folder\n');
  await fs.symlink(path.join(root, 'repos', 'notes'), path.join(root, 'repos', 'linked'));
  await fs.symlink(path.join(root, 'repos', 'README.md'), path.join(root, 'repos', 'linked-file'));
  await fs.mkdir(path.join(root, 'outside'), { recursive: true });
}

async function refusal(p: Promise<unknown>): Promise<number> {
  try {
    await p;
  } catch (err) {
    if (err instanceof BrowseError) return err.status;
    throw err;
  }
  throw new Error('expected a BrowseError');
}

describe('listDirs', () => {
  let root: string;
  let home: string;
  let repos: string;

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dir-browse-')));
    await tree(root);
    home = path.join(root, 'repos');
    repos = home;
  });

  afterAll(() => fs.rm(root, { recursive: true, force: true }));

  it('lists folders only, sorted case-insensitively, with a git badge', async () => {
    const l = await listDirs({ target: repos, home, roots: [repos] });
    expect(l.path).toBe(repos);
    expect(l.entries.map(e => [e.name, e.git])).toEqual([
      ['Api', true],
      ['linked', false],
      ['notes', false],
      ['web', true],
    ]);
    expect(l.truncated).toBe(false);
  });

  it('hides dot-folders, files and symlinks to files', async () => {
    const names = (await listDirs({ target: repos, home, roots: [] })).entries.map(e => e.name);
    expect(names).not.toContain('.cache');
    expect(names).not.toContain('README.md');
    expect(names).not.toContain('linked-file');
  });

  it('defaults to the first repo root, then home, and expands ~', async () => {
    const notes = path.join(repos, 'notes');
    expect((await listDirs({ home, roots: [notes] })).path).toBe(notes);
    expect((await listDirs({ home, roots: [] })).path).toBe(home);
    expect((await listDirs({ target: '~/notes', home, roots: [] })).path).toBe(notes);
  });

  it('gives a parent only inside what may be browsed', async () => {
    expect((await listDirs({ target: path.join(repos, 'web'), home, roots: [] })).parent).toBe(repos);
    expect((await listDirs({ target: home, home, roots: [] })).parent).toBeNull();
  });

  it('offers Home and each repo root as shortcuts', async () => {
    const notes = path.join(repos, 'notes');
    const l = await listDirs({ home, roots: [home, notes] });
    expect(l.roots).toEqual([
      { label: 'Home', path: home },
      { label: '~/notes', path: notes },
    ]);
  });

  it('refuses what is outside home and the roots, missing, a file, or relative', async () => {
    expect(await refusal(listDirs({ target: path.join(root, 'outside'), home, roots: [] }))).toBe(403);
    expect(await refusal(listDirs({ target: path.join(repos, '..', 'outside'), home, roots: [] }))).toBe(403);
    expect(await refusal(listDirs({ target: path.join(repos, 'gone'), home, roots: [] }))).toBe(404);
    expect(await refusal(listDirs({ target: path.join(repos, 'README.md'), home, roots: [] }))).toBe(400);
    expect(await refusal(listDirs({ target: 'repos/web', home, roots: [] }))).toBe(400);
  });

  it('allows a repo root that is outside home', async () => {
    const outside = path.join(root, 'outside');
    expect((await listDirs({ target: outside, home, roots: [outside] })).path).toBe(outside);
  });
});

describe('GET /api/repos/browse', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let repos: string;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await fs.realpath(await makeWorkspace('dir-browse'));
    await tree(tmpRoot);
    repos = path.join(tmpRoot, 'repos');
    process.env.SAMMY_REPO_ROOTS = repos;
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    restoreEnv();
  });

  const get = (query: string, host?: string) =>
    new Promise<{ status: number; body: { error?: string; path?: string; entries?: Array<{ name: string; git: boolean }> } }>(
      (resolve, reject) => {
        const url = new URL(`${mount.baseUrl}/api/repos/browse${query}`);
        const req = http.get(
          { hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: host ? { host } : {} },
          res => {
            let data = '';
            res.on('data', c => (data += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data || '{}') }));
          },
        );
        req.on('error', reject);
      },
    );

  it('lists the repo root by default for a local request', async () => {
    const { status, body } = await get('');
    expect(status).toBe(200);
    expect(body.path).toBe(repos);
    expect(body.entries?.find(e => e.name === 'web')?.git).toBe(true);
  });

  it('lists a named folder, and refuses one outside the roots', async () => {
    expect((await get(`?path=${encodeURIComponent(path.join(repos, 'web'))}`)).status).toBe(200);
    expect((await get(`?path=${encodeURIComponent(path.join(tmpRoot, 'outside'))}`)).status).toBe(403);
    expect((await get(`?path=${encodeURIComponent(path.join(repos, 'gone'))}`)).status).toBe(404);
  });

  it('refuses a request whose Host is not this machine (DNS rebinding)', async () => {
    const { status, body } = await get('', 'evil.example:80');
    expect(status).toBe(403);
    expect(body.error).toMatch(/own machine/);
  });
});
