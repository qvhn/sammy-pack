/**
 * Through real runs:
 *   - an `http` step with `auth.basic` + `files` uploads a `code.artifact` log
 *     recorded BEFORE an approval gate, after the run resumed past it (the
 *     artifact is read back from the stored run) — and the Basic credential
 *     never shows up in the run's record;
 *   - `code.cwd` runs a command inside one of several worktrees, and refuses
 *     a directory outside them, including through a symlink.
 */

import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  approveGate,
  getRun,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  startRun,
  waitFor,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(60_000);

const TOKEN = 'jira-token-0123456789-abcdef';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('lifecycle: http upload + auth, code.cwd', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;
  let target: http.Server;
  let base: string;
  const hits: Array<{ url: string; auth?: string; ctype?: string; body: string }> = [];

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_ALLOW_CODE_RUN = '1';
    target = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        hits.push({ url: req.url ?? '', auth: req.headers.authorization, ctype: req.headers['content-type'], body });
        res.end(JSON.stringify({ ok: true, echoedAuth: req.headers.authorization }));
      });
    });
    await new Promise<void>(r => target.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    tmpRoot = await fs.realpath(await makeWorkspace('upload-cwd'));
    await fs.writeFile(
      path.join(tmpRoot, 'credentials.json'),
      JSON.stringify({ jira: { kind: 'jira', value: TOKEN, fields: { email: 'bot@example.test' } } }),
    );
    for (const r of ['repo-a', 'repo-b']) {
      const dir = path.join(tmpRoot, r);
      await fs.mkdir(dir);
      git(dir, 'init', '-q', '-b', 'main');
      await fs.writeFile(path.join(dir, `${r}.txt`), r);
      git(dir, 'add', '.');
      git(dir, '-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    }
    // A symlink inside repo-b that points OUT of every worktree.
    await fs.symlink(tmpRoot, path.join(tmpRoot, 'repo-b', 'escape'));
    git(path.join(tmpRoot, 'repo-b'), 'add', 'escape');
    git(path.join(tmpRoot, 'repo-b'), '-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'link');

    await writeOrchestration(tmpRoot, {
      name: 'attach-after-gate',
      phases: [
        { name: 'repro', code: { run: "sh -c 'echo FAILING TEST OUTPUT; exit 0'", artifact: 'repro-log' } },
        { name: 'gate', lock: true, code: { source: "return 'approved';" } },
        {
          name: 'attach',
          http: {
            url: `${base}/rest/api/3/issue/ABC-1/attachments`,
            method: 'POST',
            headers: { 'X-Atlassian-Token': 'no-check' },
            auth: { basic: { username: '${connections:jira.fields.email}', password: '${connections:jira.value}' } },
            files: [{ artifact: 'repro-log', filename: 'repro.txt' }],
            allowHosts: ['127.0.0.1'],
          },
        },
      ],
    });
    const worktrees = [
      { name: 'a', repo: 'repo-a' },
      { name: 'b', repo: 'repo-b' },
    ];
    await writeOrchestration(tmpRoot, {
      name: 'cwd-ok',
      worktrees,
      phases: [{ name: 'in-b', code: { run: 'ls', cwd: '${worktrees.b.path}' } }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'cwd-outside',
      worktrees,
      phases: [{ name: 'out', code: { run: 'ls', cwd: '/tmp' } }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'cwd-relative',
      worktrees,
      phases: [{ name: 'rel', code: { run: 'ls', cwd: 'sub' } }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'cat-registry',
      vars: { credPath: path.join(tmpRoot, 'credentials.json') },
      phases: [{ name: 'leak', code: { run: 'cat ${credPath}' } }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'cwd-symlink',
      worktrees,
      phases: [{ name: 'out', code: { run: 'ls', cwd: '${worktrees.b.path}/escape' } }],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    (target as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>(r => target.close(() => r()));
    // A run's worktree cleanup finishes just after its status turns terminal,
    // so git may still be writing under tmpRoot — retry ENOTEMPTY.
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    restoreEnv();
  });

  const settled = (id: string, status: string) =>
    waitFor(async () => {
      const r = await getRun(mount.baseUrl, id);
      return r.status === status ? r : null;
    }, `run ${status}`, { timeoutMs: 25_000, intervalMs: 100 });

  it('uploads an artifact recorded before the gate, with Basic auth, after resuming', async () => {
    const id = (await startRun(mount.baseUrl, 'attach-after-gate')).id!;
    await settled(id, 'paused');
    expect(hits).toHaveLength(0);
    await approveGate(mount.baseUrl, id);
    const run = await settled(id, 'done');
    expect(hits).toHaveLength(1);
    const h = hits[0];
    expect(h.url).toBe('/rest/api/3/issue/ABC-1/attachments');
    expect(h.auth).toBe(`Basic ${Buffer.from(`bot@example.test:${TOKEN}`).toString('base64')}`);
    expect(h.ctype).toMatch(/^multipart\/form-data; boundary=/);
    expect(h.body).toContain('filename="repro.txt"');
    expect(h.body).toContain('FAILING TEST OUTPUT');
    const record = JSON.stringify(run);
    expect(record).not.toContain(TOKEN);
    const art = run.events.find(e => e.type === 'artifact');
    expect(art?.replayKey).toBe('repro');
    expect(record).not.toContain(Buffer.from(`bot@example.test:${TOKEN}`).toString('base64'));
  });

  it('runs a command in the worktree code.cwd names', async () => {
    const id = (await startRun(mount.baseUrl, 'cwd-ok')).id!;
    const run = await settled(id, 'done');
    expect(String(run.lastOutput)).toContain('repo-b.txt');
  });

  it('refuses a relative cwd when several worktrees are declared', async () => {
    const id = (await startRun(mount.baseUrl, 'cwd-relative')).id!;
    const run = await settled(id, 'error');
    expect(JSON.stringify(run.events)).toMatch(/is relative, but this run declares 2 worktrees/);
  });

  it('scrubs a registry secret the run was never given from its output', async () => {
    // The run declares no credential, yet its command prints the registry.
    const id = (await startRun(mount.baseUrl, 'cat-registry')).id!;
    const run = await waitFor(async () => {
      const r = await getRun(mount.baseUrl, id);
      return r.status === 'done' || r.status === 'error' ? r : null;
    }, 'settled', { timeoutMs: 25_000, intervalMs: 100 });
    expect(run.status).toBe('done');
    expect(String(run.lastOutput)).toContain('bot@example.test'); // the file WAS printed
    expect(JSON.stringify(run)).not.toContain(TOKEN);
  });

  it('refuses a cwd outside the run\'s worktrees, including through a symlink', async () => {
    for (const name of ['cwd-outside', 'cwd-symlink']) {
      const id = (await startRun(mount.baseUrl, name)).id!;
      const run = await settled(id, 'error');
      expect(JSON.stringify(run.events)).toMatch(/is not inside one of this run's worktrees/);
    }
  });
});
