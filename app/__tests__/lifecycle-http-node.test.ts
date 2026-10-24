/**
 * The `http` leaf through a real run: the request carries a credential from
 * the registry, the credential never appears in the run's output or events,
 * and a run resumed past a later gate REPLAYS the completed request instead of
 * sending it again (a write-back must not double-post).
 */

import http from 'node:http';
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

const SECRET = 'tok-0123456789abcdef-SECRET';

describe('lifecycle: http node', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;
  let target: http.Server;
  let base: string;
  const hits: Array<{ method: string; url: string; auth?: string; body: string }> = [];

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    target = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        hits.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body });
        if (req.url?.startsWith('/fail')) {
          res.writeHead(500);
          return res.end('boom');
        }
        // Echo the auth header back, as a careless API might.
        res.end(JSON.stringify({ ok: true, echoedAuth: req.headers.authorization, got: body }));
      });
    });
    await new Promise<void>(r => target.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    tmpRoot = await makeWorkspace('http-node');
    await fs.writeFile(
      path.join(tmpRoot, 'credentials.json'),
      JSON.stringify({ tracker: { kind: 'api-key', value: SECRET } }),
    );
    await writeOrchestration(tmpRoot, {
      name: 'write-back',
      phases: [
        {
          name: 'post',
          http: {
            url: `${base}/groups/\${input.id}`,
            method: 'PATCH',
            headers: { authorization: 'Bearer ${connections:tracker.value}' },
            body: { status: 'ticketed', id: '${input.id}' },
            allowHosts: ['127.0.0.1'],
          },
          as: 'resp',
        },
        { name: 'approve', lock: true, code: { source: 'return state.resp;' } },
      ],
    });
    await writeOrchestration(tmpRoot, {
      name: 'write-fail',
      phases: [{ name: 'post', http: { url: `${base}/fail`, method: 'POST', allowHosts: ['127.0.0.1'] } }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'write-denied',
      phases: [{ name: 'post', http: { url: 'http://169.254.169.254/latest/meta-data' } }],
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

  it('sends once with the credential, scrubs it, and replays on resume', async () => {
    const id = (await startRun(mount.baseUrl, 'write-back', JSON.stringify({ id: 42 }))).id!;
    await waitFor(async () => ((await getRun(mount.baseUrl, id)).status === 'paused' ? true : null), 'gate');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ method: 'PATCH', url: '/groups/42', auth: `Bearer ${SECRET}` });
    expect(JSON.parse(hits[0].body)).toEqual({ status: 'ticketed', id: 42 });

    await approveGate(mount.baseUrl, id);
    const run = await waitFor(async () => {
      const r = await getRun(mount.baseUrl, id);
      return r.status === 'done' ? r : null;
    }, 'done');
    expect(hits).toHaveLength(1); // replayed, not re-sent
    const serialized = JSON.stringify(run);
    expect(serialized).not.toContain(SECRET);
    expect(run.lastOutput).toContain('"ok":true');
  });

  it('fails the phase on a non-2xx with the status in the error', async () => {
    const id = (await startRun(mount.baseUrl, 'write-fail')).id!;
    const run = await waitFor(async () => {
      const r = await getRun(mount.baseUrl, id);
      return r.status === 'error' ? r : null;
    }, 'error');
    const err = run.events.find(e => e.type === 'phase-error');
    expect(String(err?.error)).toMatch(/returned 500\nboom/);
  });

  it('refuses a host with no allowlist', async () => {
    const id = (await startRun(mount.baseUrl, 'write-denied')).id!;
    const run = await waitFor(async () => {
      const r = await getRun(mount.baseUrl, id);
      return r.status === 'error' ? r : null;
    }, 'error');
    const err = run.events.find(e => e.type === 'phase-error');
    expect(String(err?.error)).toMatch(/no allowed hosts/);
  });
});
