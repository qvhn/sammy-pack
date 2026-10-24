/**
 * `http.files` artifact resolution across a fork and the artifact budget:
 *  1. A FORK replays the `code.artifact` leaf from the source run without
 *     re-running it, and its new run id has no artifacts of its own — the
 *     fork must carry the replayed leaf's artifact so the upload still works.
 *  2. When the run's artifact budget is spent, the budget notice must not be
 *     uploaded in place of the log; the upload fails instead.
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import {
  getRun, makeWorkspace, mountServer, pinTestEnv, postJson, startRun, waitFor, writeOrchestration, type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(60_000);

describe('http.files across a fork and the artifact budget', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;
  let target: http.Server;
  let base: string;
  const hits: string[] = [];

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_ALLOW_CODE_RUN = '1';
    target = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => { hits.push(body); res.end('{"ok":true}'); });
    });
    await new Promise<void>(r => target.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    tmpRoot = await fs.realpath(await makeWorkspace('upload-fork'));
    await writeOrchestration(tmpRoot, {
      name: 'attach',
      phases: [
        { name: 'repro', code: { run: "sh -c 'echo FAILING TEST OUTPUT'", artifact: 'repro-log' } },
        { name: 'upload', http: { url: `${base}/att`, method: 'POST', files: [{ artifact: 'repro-log' }], allowHosts: ['127.0.0.1'] } },
      ],
    });
    mount = await mountServer(tmpRoot);
  });
  afterAll(async () => {
    await mount?.kill();
    (target as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>(r => target.close(() => r()));
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });
  const terminal = (id: string) =>
    waitFor(async () => {
      const r = await getRun(mount.baseUrl, id);
      return ['done', 'error'].includes(r.status) ? r : null;
    }, 'terminal', { timeoutMs: 25_000, intervalMs: 100 });

  it('a fork that replays the artifact leaf can still upload it', async () => {
    const id = (await startRun(mount.baseUrl, 'attach')).id!;
    expect((await terminal(id)).status).toBe('done');
    const fork = await postJson<{ id: string }>(`${mount.baseUrl}/api/runs/${id}/fork`, { atPhase: 'upload' });
    expect(fork.status).toBe(200);
    const run = await terminal(fork.body.id);
    expect(JSON.stringify(run.events)).not.toMatch(/no artifact named/);
    expect(run.status).toBe('done');
  });

  it('does not silently upload the budget-dropped placeholder as the file', async () => {
    process.env.SAMMY_ARTIFACT_RUN_MAX_BYTES = '5';
    try {
      hits.length = 0;
      const id = (await startRun(mount.baseUrl, 'attach')).id!;
      const run = await terminal(id);
      const uploadedPlaceholder = hits.some(h => h.includes('artifact dropped'));
      // Either the run fails loudly, or the real content is sent — not "done" with a placeholder file.
      expect(run.status === 'done' && uploadedPlaceholder).toBe(false);
    } finally {
      delete process.env.SAMMY_ARTIFACT_RUN_MAX_BYTES;
    }
  });
});
