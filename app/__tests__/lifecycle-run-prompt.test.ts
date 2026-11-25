/**
 * Starting a run the way the Run dialog does: one prompt, attached files and
 * the repo to work in (`prompt: true`, `attachments`, `repo` on
 * POST /api/runs/start), through the real server.
 *
 *  - A repo for an orchestration that declares no worktrees still gets the
 *    run its own worktree (named `repo`), removed at the end like a declared one.
 *  - An orchestration written for typed inputs runs from the prompt unchanged:
 *    the repo fills the input its worktree reads, the prompt the first other.
 *  - Attached files are saved for the agents and listed under the prompt.
 */

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  getRun,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  postJson,
  waitFor,
  writeOrchestration,
  type ApiRun,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(90_000);

// Git work under a busy full-suite run can take far longer than alone.
const SLOW = { timeoutMs: 60_000 };

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('lifecycle: starting from a prompt', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let repo: string;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_ALLOW_CODE_RUN = '1';
    tmpRoot = await fs.realpath(await makeWorkspace('run-prompt'));
    repo = path.join(tmpRoot, 'target-repo');
    await fs.mkdir(repo);
    git(repo, 'init', '-q', '-b', 'main');
    await fs.writeFile(path.join(repo, 'README'), 'hello\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    await writeOrchestration(tmpRoot, {
      name: 'no-worktrees',
      phases: [
        {
          name: 'where',
          code: {
            run:
              '[ "$(pwd -P)" = "$(cd "$SAMMY_WORKTREE_REPO" && pwd -P)" ] && echo cwd-is-worktree; ' +
              'git rev-parse --abbrev-ref HEAD; cat README',
          },
        },
      ],
    });
    await writeOrchestration(tmpRoot, {
      name: 'typed',
      inputs: [
        { name: 'ticket', kind: 'jira', required: true },
        { name: 'repo', kind: 'text', required: true },
      ],
      worktrees: [{ name: 'repo', repo: '${repo}' }],
      phases: [{ name: 'echo', code: { source: 'return state.ticket + "\\n--\\n" + input;' } }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'echo-input',
      phases: [{ name: 'echo', code: { source: 'return input;' } }],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    restoreEnv();
  });

  const start = (body: Record<string, unknown>) =>
    postJson<{ id?: string; error?: string }>(`${mount.baseUrl}/api/runs/start`, body);
  const finished = (id: string) =>
    waitFor(async () => {
      const r = await getRun(mount.baseUrl, id);
      return ['done', 'error'].includes(r.status) ? r : null;
    }, 'run finished', SLOW);
  const snapshotOf = async (id: string) =>
    (await getRun(mount.baseUrl, id)) as ApiRun & { orchestrationSnapshot?: { worktrees?: unknown } };

  it('gives an orchestration without worktrees its own worktree of the repo, then removes it', async () => {
    const { status, body } = await start({
      orchestrationName: 'no-worktrees',
      initialInput: 'look around',
      prompt: true,
      repo,
    });
    expect(status).toBe(200);
    const id = body.id!;
    const done = await finished(id);
    expect(done.status).toBe('done');
    const lines = String(done.lastOutput).trim().split('\n');
    expect(lines[0]).toBe('cwd-is-worktree');
    expect(lines[1]).toMatch(/^sammy\/.+-repo$/);
    expect(lines[2]).toBe('hello');
    expect((await snapshotOf(id)).orchestrationSnapshot?.worktrees).toEqual([{ name: 'repo', repo }]);
    const wt = path.join(tmpRoot, '.worktrees', 'no-worktrees', id, 'repo');
    await waitFor(async () => ((await fs.access(wt).then(() => false).catch(() => true)) ? true : null), 'worktree removed', SLOW);
    // The checkout itself was never touched.
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('two runs of the same pipeline on the same repo each get their own worktree and branch', async () => {
    const a = (await start({ orchestrationName: 'no-worktrees', prompt: true, repo })).body.id!;
    const b = (await start({ orchestrationName: 'no-worktrees', prompt: true, repo })).body.id!;
    const [ra, rb] = await Promise.all([finished(a), finished(b)]);
    expect([ra.status, rb.status]).toEqual(['done', 'done']);
    const branchOf = (r: ApiRun) => String(r.lastOutput).trim().split('\n')[1];
    expect(branchOf(ra)).not.toBe(branchOf(rb));
  });

  it('fills typed inputs from the prompt and the repo', async () => {
    const { status, body } = await start({
      orchestrationName: 'typed',
      initialInput: 'The login page redirects twice after sign-in',
      prompt: true,
      repo,
    });
    expect(status).toBe(200);
    const done = await finished(body.id!);
    expect(done.status).toBe('done');
    const [ticket, input] = String(done.lastOutput).split('\n--\n');
    expect(ticket).toMatch(/described by the person who started the run/);
    expect(ticket).toMatch(/redirects twice after sign-in/);
    expect(input).toBe('The login page redirects twice after sign-in');
  });

  it('refuses a typed-inputs run with no repo, naming the input', async () => {
    const { status, body } = await start({
      orchestrationName: 'typed',
      initialInput: 'The login page redirects twice after sign-in',
      prompt: true,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/required input "repo"/);
  });

  it('saves attached files and lists them under the prompt', async () => {
    const { status, body } = await start({
      orchestrationName: 'echo-input',
      initialInput: 'Use the notes',
      prompt: true,
      attachments: [{ filename: 'notes.txt', mediaType: 'text/plain', data: Buffer.from('step one\nstep two\n').toString('base64') }],
    });
    expect(status).toBe(200);
    const done = await finished(body.id!);
    const out = String(done.lastOutput);
    expect(out.startsWith('Use the notes\n')).toBe(true);
    expect(out).toContain('--- Context attached to this run');
    expect(out).toContain('step one');
    // The path is in the prompt (the scrubber masks this test's random temp
    // folder in the run's output, so find the file by its place instead).
    expect(out).toMatch(/File: notes\.txt \(saved at .*\.worktrees\/_attachments\/_uploads\/[^/]+\/notes\.txt\)/);
    const uploads = path.join(tmpRoot, '.worktrees', '_attachments', '_uploads');
    const [dir] = await fs.readdir(uploads);
    expect(await fs.readFile(path.join(uploads, dir, 'notes.txt'), 'utf8')).toBe('step one\nstep two\n');
  });

  it('leaves a plain prompt with nothing to fetch as typed', async () => {
    const { body } = await start({ orchestrationName: 'echo-input', initialInput: 'just words', prompt: true });
    expect(String((await finished(body.id!)).lastOutput)).toBe('just words');
  });
});
