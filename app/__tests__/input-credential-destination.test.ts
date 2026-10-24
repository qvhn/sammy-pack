/**
 * POST /api/runs/start resolves an orchestration's declared `inputs` with the
 * credentials visible to the caller. A `github` input is fetched with
 * `Authorization: Bearer <stored PAT>`, so the resolver — not the caller —
 * must decide the DESTINATION of that request. It did not: a value the
 * github.com issue/PR regex missed was fetched verbatim, and one run-start
 * delivered the stored PAT, in plaintext, to any host.
 *
 * These cases drive the REAL mount against a real local sink and assert on the
 * SINK, not only on the status code: a refusal that fired after the fetch
 * would already have leaked.
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  pinTestEnv,
  makeWorkspace,
  mountServer,
  writeOrchestration,
  postJson,
  putJson,
  type Mount,
} from './lifecycle-harness.helpers';

const PAT = 'ghp_SUPERSECRETPAT0123456789abcdefghij';

type SinkHit = { url: string; authorization?: string };

/** A throwaway http server that records every request it is handed. */
async function startSink(): Promise<{
  origin: string;
  hits: SinkHit[];
  close: () => Promise<void>;
}> {
  const hits: SinkHit[] = [];
  const server = http.createServer((req, res) => {
    hits.push({
      url: req.url ?? '',
      authorization: req.headers.authorization,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"number":1,"title":"x","state":"open","body":""}');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    hits,
    close: () =>
      new Promise<void>(r => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

describe('a run input never picks the destination of a stored credential', () => {
  const restoreEnv = pinTestEnv();
  let tmpRoot: string;
  let mount: Mount;
  let sink: Awaited<ReturnType<typeof startSink>>;

  const writeCredentials = async (owners?: string[]): Promise<void> => {
    await fs.writeFile(
      path.join(tmpRoot, 'credentials.json'),
      JSON.stringify({
        'gh-bot': { kind: 'github', value: PAT, ...(owners ? { owners } : {}) },
      }),
      'utf8',
    );
  };

  beforeAll(async () => {
    tmpRoot = await makeWorkspace('input-dest');
    await writeCredentials();
    await writeOrchestration(tmpRoot, {
      name: 'gh-intake',
      inputs: [{ name: 'ticket', kind: 'github', required: true }],
      phases: [{ name: 'echo', code: { source: 'return "ok"' } }],
    });
    sink = await startSink();
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    await sink?.close();
    restoreEnv();
  });

  test('an anonymous start cannot send the PAT to a host it named', async () => {
    const { status, body } = await postJson<{ error?: string }>(
      `${mount.baseUrl}/api/runs/start`,
      {
        orchestrationName: 'gh-intake',
        inputs: { ticket: { value: `${sink.origin}/exfil` } },
      },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/not a GitHub issue\/PR reference/);
    expect(sink.hits).toEqual([]);
  });

  test('a github.com LOOKALIKE host is refused with no request', async () => {
    const { status } = await postJson(`${mount.baseUrl}/api/runs/start`, {
      orchestrationName: 'gh-intake',
      inputs: {
        ticket: { value: 'https://github.com.evil.example/a/b/issues/1' },
      },
    });
    expect(status).toBe(400);
    expect(sink.hits).toEqual([]);
  });

  test('an orchestration the caller minted itself gets the same refusal', async () => {
    const put = await putJson(`${mount.baseUrl}/api/orchestrations/evil`, {
      name: 'evil',
      inputs: [{ name: 'ticket', kind: 'github', required: true }],
      phases: [{ name: 'echo', code: { source: 'return "ok"' } }],
    });
    expect(put.status).toBe(200);
    const { status } = await postJson(`${mount.baseUrl}/api/runs/start`, {
      orchestrationName: 'evil',
      inputs: { ticket: { value: `${sink.origin}/self-authored` } },
    });
    expect(status).toBe(400);
    expect(sink.hits).toEqual([]);
  });

  test('naming the owner in the identity header does not unlock a scoped PAT', async () => {
    await writeCredentials(['alice']);
    const { status } = await postJson(
      `${mount.baseUrl}/api/runs/start`,
      {
        orchestrationName: 'gh-intake',
        inputs: { ticket: { value: `${sink.origin}/as-alice` } },
      },
      { 'x-sammy-user': 'alice' },
    );
    expect(status).toBe(400);
    expect(sink.hits).toEqual([]);
  });
});
