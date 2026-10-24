/**
 * POLLING TIMERS MUST NOT LEAK ACROSS MOUNTS.
 *
 * Trigger registration kept its polling tasks in a map owned by the MOUNT's
 * closure. That stops them on a re-save, but not on a RE-MOUNT inside one
 * process — which is exactly what a vite dev restart or an HMR reload does.
 * The new mount's closure cannot see the previous mount's map, so the old
 * pollers kept running: invisible, unstoppable, each still fetching its
 * source and delivering. Every reload added another, so one URL ended up
 * polled N times, N growing with the length of the dev session.
 *
 * Cron had this fixed deliberately after a leak that pegged a laptop —
 * node-cron keeps a process-global registry, so registration uses a
 * deterministic name and destroys any pre-existing task with it. Polling had
 * no registry, so it had no fix. These cases pin the equivalent.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import {
  destroySammyCronTasks,
  destroySammyPollers,
  livePollers,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  putJson,
  waitFor,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(45_000);

const ORCH = 'poller-leak';

describe('lifecycle: the polling registry is process-global', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount1: Mount | undefined;
  let mount2: Mount | undefined;
  let server: http.Server;
  let url: string;
  /** Counts actual HTTP hits — the only honest measure of "how many pollers
   *  are alive", since a leaked one is by definition untracked. */
  let hits = 0;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    destroySammyPollers();
    server = http.createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('same-body-every-time');
    });
    await new Promise<void>(r => server.listen(0, r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/feed`;

    tmpRoot = await makeWorkspace('poller-leak');
    await writeOrchestration(tmpRoot, {
      name: ORCH,
      triggers: [{ kind: 'polling', source: url, intervalSeconds: 1 }],
      phases: [{ name: 'echo', code: { source: 'return input;' } }],
    });
  });

  afterAll(async () => {
    await mount1?.kill();
    await mount2?.kill();
    destroySammyCronTasks();
    destroySammyPollers();
    await new Promise<void>(r => server?.close(() => r()));
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  it('a mount registers exactly one poller, under a deterministic name', async () => {
    mount1 = await mountServer(tmpRoot);
    const names = await waitFor(
      async () => {
        const live = livePollers().filter(n => n.includes(ORCH));
        return live.length > 0 ? live : null;
      },
      'poller registered',
      { timeoutMs: 10_000, intervalMs: 50 },
    );
    expect(names).toEqual([`sammy:poll:${ORCH}:${url}`]);
  });

  it('a RE-MOUNT in the same process keeps one registry entry', async () => {
    // BOOKKEEPING ONLY, and deliberately labelled as such: the registry is a
    // Map keyed by name, so a re-registration overwrites the entry whether or
    // not the predecessor's timer was stopped. This assertion therefore still
    // passes while the leak is live — verified by reverting the fix. The
    // behavioural proof is the next case.
    mount2 = await mountServer(tmpRoot);
    await new Promise(r => setTimeout(r, 300));
    expect(livePollers().filter(n => n.includes(ORCH))).toEqual([
      `sammy:poll:${ORCH}:${url}`,
    ]);
  });

  it('and only ONE poller is actually FETCHING (the real assertion)', async () => {
    // Counts real HTTP requests, which is the only honest measure: a leaked
    // poller is by definition untracked, so no amount of registry inspection
    // can see it. This case fails when the cross-mount sweep is removed.
    await waitFor(
      async () => (hits > 0 ? true : null),
      'the poller fetched at least once',
      { timeoutMs: 10_000, intervalMs: 50 },
    );
    const before = hits;
    await new Promise(r => setTimeout(r, 3_200)); // ~3 ticks at 1s
    const delta = hits - before;
    // One poller at ~1s/tick with ±10% jitter: expect ~3, allow 1–5. Two
    // live pollers would land at ~6.
    expect(delta).toBeGreaterThanOrEqual(1);
    expect(delta).toBeLessThanOrEqual(5);
  });

  it('a re-save replaces the poller rather than stacking another', async () => {
    const { status } = await putJson(`${mount2!.baseUrl}/api/orchestrations/${ORCH}`, {
      name: ORCH,
      triggers: [{ kind: 'polling', source: url, intervalSeconds: 2 }],
      phases: [{ name: 'echo', code: { source: 'return input;' } }],
    });
    expect(status).toBe(200);
    await new Promise(r => setTimeout(r, 300));
    expect(livePollers().filter(n => n.includes(ORCH))).toEqual([
      `sammy:poll:${ORCH}:${url}`,
    ]);
  });

  it('closing the mount stops polling entirely', async () => {
    await mount1?.kill();
    await mount2?.kill();
    mount1 = undefined;
    mount2 = undefined;
    // The shutdown hook sweeps the global registry, not just its own map.
    expect(livePollers().filter(n => n.includes(ORCH))).toEqual([]);
    await new Promise(r => setTimeout(r, 300));
    const after = hits;
    await new Promise(r => setTimeout(r, 2_500));
    // A closed mount must not keep fetching an external URL.
    expect(hits).toBe(after);
  });
});
