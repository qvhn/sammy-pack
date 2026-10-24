/**
 * `notify.onGate` end to end: a run that stops at an approval gate POSTs a
 * gate envelope (with `text`, for chat webhooks) to the configured URL — for
 * EVERY gate it reaches, including the second gate of a run resumed through
 * an approval — while a timed `wait` pause does not.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import {
  approveGate,
  getRun,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  sleep,
  startRun,
  waitFor,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(60_000);

type Received = { path: string; body: Record<string, unknown> };

describe('lifecycle: notify.onGate', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;
  let sink: http.Server;
  let sinkUrl: string;
  const received: Received[] = [];
  const savedPublic = process.env.SAMMY_PUBLIC_URL;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_PUBLIC_URL = 'https://sammy.example.test/';
    sink = http.createServer((req, res) => {
      let data = '';
      req.on('data', c => (data += c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', body: JSON.parse(data || '{}') });
        res.end('ok');
      });
    });
    await new Promise<void>(r => sink.listen(0, r));
    sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
    tmpRoot = await makeWorkspace('gate-notify');
    await writeOrchestration(tmpRoot, {
      name: 'two-gates',
      notify: { onGate: `${sinkUrl}/gate` },
      phases: [
        { name: 'plan', lock: true, code: { source: "return 'the plan';" } },
        { name: 'ship', lock: true, code: { source: "return 'the change';" } },
      ],
    });
    await writeOrchestration(tmpRoot, {
      name: 'timed-wait',
      notify: { onGate: `${sinkUrl}/gate`, onTerminal: `${sinkUrl}/terminal` },
      phases: [{ name: 'later', wait: { seconds: 3600 } }],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    await new Promise<void>(r => sink.close(() => r()));
    await fs.rm(tmpRoot, { recursive: true, force: true });
    if (savedPublic === undefined) delete process.env.SAMMY_PUBLIC_URL;
    else process.env.SAMMY_PUBLIC_URL = savedPublic;
    restoreEnv();
  });

  const gateHits = (runId: string) =>
    received.filter(r => r.path === '/gate' && r.body.runId === runId);

  it('fires once per gate reached, including after an approval resumes the run', async () => {
    const id = (await startRun(mount.baseUrl, 'two-gates')).id!;
    await waitFor(async () => (gateHits(id).length === 1 ? true : null), 'first gate notify');
    const first = gateHits(id)[0].body;
    expect(first).toMatchObject({
      type: 'gate',
      status: 'paused',
      orchestration: 'two-gates',
      gate: 'plan',
      appUrl: 'https://sammy.example.test/',
      runUrl: `https://sammy.example.test/api/runs/${id}`,
    });
    expect(String(first.text)).toMatch(/Approval needed: two-gates .* waiting at "plan"/);

    await approveGate(mount.baseUrl, id);
    await waitFor(async () => (gateHits(id).length === 2 ? true : null), 'second gate notify');
    expect(gateHits(id)[1].body.gate).toBe('ship');

    await approveGate(mount.baseUrl, id);
    await waitFor(async () => ((await getRun(mount.baseUrl, id)).status === 'done' ? true : null), 'done');
    await sleep(200);
    expect(gateHits(id)).toHaveLength(2);
  });

  it('does not fire for a timed wait pause (onTerminal still does)', async () => {
    const id = (await startRun(mount.baseUrl, 'timed-wait')).id!;
    await waitFor(
      async () => ((await getRun(mount.baseUrl, id)).status === 'paused' ? true : null),
      'wait pause',
    );
    await waitFor(
      async () =>
        received.some(r => r.path === '/terminal' && r.body.runId === id) ? true : null,
      'terminal notify for the pause',
    );
    await sleep(200);
    expect(gateHits(id)).toHaveLength(0);
  });
});
