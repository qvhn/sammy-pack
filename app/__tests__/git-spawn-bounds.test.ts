/**
 * The per-child bounds on the reads that SPAWN.
 *
 * `GET /api/versions` shells out to `git log` / `git show`. Two bounds keep
 * one wedged child from holding a request (and one of the four shedding
 * slots) forever: a wall-clock `timeout` and a ceiling on buffered stdout.
 * Only the in-flight ceiling (`SAMMY_MAX_SPAWNING_READS`) had a test —
 * inverting either of these two left the whole suite green, so neither was a
 * bound anyone had measured.
 *
 * Driven against the REAL `git`, with three mounts over three workspaces that
 * differ only in the bound under test, so the status difference IS the bound:
 *   - the control answers 200 for an ordinary log;
 *   - with the stdout ceiling at one byte the same read is refused;
 *   - a repo whose config `include.path` is an unopened FIFO makes git block
 *     before it does anything (a config include is read at startup, and
 *     opening a FIFO with no writer blocks), so only the timeout can reap it.
 * A PATH shim would be the obvious way to script a hanging child, but jest
 * hands the test a COPY of `process.env`, so a mutated PATH never reaches a
 * spawned child's environment — the FIFO is what makes the hang real.
 *
 * POSIX-only: the FIFO is. The bounds themselves are platform-agnostic.
 */

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(90_000);

const TIMEOUT_MS = 1_500;

/** One request down a fresh socket. `status: null` means no response head
 *  ever arrived inside the budget — the child was never reaped. */
function rawRequest(
  baseUrl: string,
  rawPath: string,
  budgetMs: number,
): Promise<{ status: number | null; ms: number }> {
  const { hostname, port } = new URL(baseUrl);
  const started = Date.now();
  return new Promise(resolve => {
    let settled = false;
    let budget: ReturnType<typeof setTimeout>;
    const done = (status: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(budget);
      resolve({ status, ms: Date.now() - started });
    };
    const req = http.request(
      { host: hostname, port, method: 'GET', path: rawPath, agent: false },
      res => {
        res.resume();
        res.on('end', () => done(res.statusCode ?? 0));
      },
    );
    req.on('error', () => done(null));
    // Cleared on the answer: an uncleared budget timer is an open handle
    // that outlives the test.
    budget = setTimeout(() => {
      req.destroy();
      done(null);
    }, budgetMs);
    req.end();
  });
}

/** A workspace that is a git repo with one commit touching the file the
 *  route will ask about, so an unbounded `git log` answers 200. */
async function gitWorkspace(prefix: string): Promise<string> {
  const root = await makeWorkspace(prefix);
  await fs.mkdir(path.join(root, 'agents'), { recursive: true });
  await fs.writeFile(path.join(root, 'agents', 'probe.md'), '# probe\n', 'utf8');
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  };
  git('init', '-q');
  git('add', 'agents/probe.md');
  git(
    '-c',
    'user.email=probe@example.test',
    '-c',
    'user.name=Probe',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'add the probe agent',
  );
  return root;
}

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('runGit is bounded in wall clock and in buffered stdout', () => {
  let restoreEnv: () => void;
  const mounts: Mount[] = [];

  beforeAll(() => {
    restoreEnv = pinTestEnv();
  });

  afterAll(async () => {
    for (const m of mounts) await m.kill();
    delete process.env.SAMMY_SPAWN_TIMEOUT_MS;
    delete process.env.SAMMY_SPAWN_MAX_STDOUT;
    restoreEnv?.();
  });

  /** Both bounds are read at MOUNT time, so each case gets its own mount. */
  async function mountWith(
    root: string,
    env: Record<string, string>,
  ): Promise<Mount> {
    delete process.env.SAMMY_SPAWN_TIMEOUT_MS;
    delete process.env.SAMMY_SPAWN_MAX_STDOUT;
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    const mount = await mountServer(root);
    mounts.push(mount);
    return mount;
  }

  it('CONTROL: an ordinary log answers 200', async () => {
    const mount = await mountWith(await gitWorkspace('spawn-control'), {
      SAMMY_SPAWN_TIMEOUT_MS: String(TIMEOUT_MS),
    });
    const r = await rawRequest(mount.baseUrl, '/api/versions/agents/probe', 10_000);
    expect(r.status).toBe(200);
  });

  it('the stdout ceiling refuses the SAME read when it is one byte', async () => {
    const mount = await mountWith(await gitWorkspace('spawn-cap'), {
      SAMMY_SPAWN_TIMEOUT_MS: String(TIMEOUT_MS),
      SAMMY_SPAWN_MAX_STDOUT: '1',
    });
    // Over-ceiling output is reported as a failed child, not shipped as a
    // body and not accumulated into a string without limit.
    const r = await rawRequest(mount.baseUrl, '/api/versions/agents/probe', 10_000);
    expect(r.status).toBe(500);
  });

  it('a git that blocks before it starts is reaped by the timeout, and the request answers', async () => {
    const root = await gitWorkspace('spawn-timeout');
    // A config include whose path is a FIFO nobody writes to: git opens it
    // while parsing config, which blocks, so the child does nothing and
    // exits only when something kills it.
    const fifo = path.join(root, 'blocking-include');
    execFileSync('mkfifo', [fifo]);
    await fs.appendFile(
      path.join(root, '.git', 'config'),
      `[include]\n\tpath = ${fifo}\n`,
      'utf8',
    );
    const mount = await mountWith(root, {
      SAMMY_SPAWN_TIMEOUT_MS: String(TIMEOUT_MS),
    });
    // Budget well above the bound and well below "forever". `status: null`
    // is how this helper reports "never answered", which is the defect: an
    // unreaped `git` leaves the request hanging and the socket leaked. So a
    // non-null status IS the assertion — deliberately not a wall-clock
    // multiple of the bound, which is the one thing here that depends on
    // machine load and made this case flake under a full parallel run.
    const r = await rawRequest(mount.baseUrl, '/api/versions/agents/probe', 15_000);
    expect(r.status).not.toBeNull();
    expect(r.status).toBe(500);
  });
});
