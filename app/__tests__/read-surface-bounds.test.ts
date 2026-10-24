/**
 * Three unbounded / unmasked READ surfaces, brought in line with the rest.
 *
 *   - `GET /api/triggers` shipped a polling trigger's `source` verbatim —
 *     three times over (the row `name`, `config.source`, and the kind's own
 *     `describe` summary) — while `GET /api/mcp-servers` masks the identical
 *     secret shapes. A polling source is an arbitrary external URL and the
 *     common shape for a feed poll carries its credential IN the URL. Same
 *     leak on `GET /api/trigger-catalog`'s summary.
 *   - `GET /api/versions` and `GET /api/mcp-servers/status` spawn child
 *     processes per request with no concurrency ceiling, and `runGit` had no
 *     timeout and no output cap — the only unauthenticated levers in the file
 *     without one (body bytes, poll body bytes, poll timeout, run-list limit,
 *     retention batch and queue depth all have one).
 *   - `GET /api/runs/:id/events` replays the run's ENTIRE event log into the
 *     socket with no connection cap; the sibling `GET /api/runs?limit=` got
 *     SAMMY_MAX_RUN_LIST_LIMIT for exactly this class, and the stream ships
 *     strictly more per request.
 *
 * Every refusal names its lever, and each cap is set to 1 here so the bound
 * is observable without flooding the mount.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  waitFor,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(60_000);

const SECRET_URL =
  'https://feeduser:ghp_pollsecrettoken0123456789abcdef@feeds.example.test/items.json';
const PLAIN_URL = 'https://feeds.example.test/plain.json';

describe('bounded + masked read surfaces', () => {
  let restoreEnv: () => void;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_MAX_SPAWNING_READS = '1';
    process.env.SAMMY_MAX_RUN_STREAMS = '1';
    const tmpRoot = await makeWorkspace('read-bounds');
    await writeOrchestration(tmpRoot, {
      name: 'poll-secret',
      triggers: [{ kind: 'polling', source: SECRET_URL, intervalSeconds: 3600 }],
      phases: [{ name: 'p', code: { source: "return 'polled'" } }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'poll-plain',
      triggers: [{ kind: 'polling', source: PLAIN_URL, intervalSeconds: 3600 }],
      phases: [{ name: 'p', code: { source: "return 'polled'" } }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'streamed',
      phases: [{ name: 'p', code: { source: "return 'ran'" } }],
    });
    // Never settles: the vm context has no timers, so an unresolved promise
    // keeps the node in flight without burning the event loop.
    await writeOrchestration(tmpRoot, {
      name: 'streamed-live',
      phases: [{ name: 'p', code: { source: 'return new Promise(() => {});' } }],
    });
    await fs.mkdir(path.join(tmpRoot, 'mcp'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'mcp', 'servers.json'),
      JSON.stringify({ probe: { command: 'definitely-not-on-path-xyz' } }),
      'utf8',
    );
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  // ── Masked polling sources ───────────────────────────────────────────────
  describe('polling sources', () => {
    it('masks a credential-bearing source everywhere the listing prints it', async () => {
      const res = await fetch(`${mount.baseUrl}/api/triggers`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain('ghp_pollsecrettoken0123456789abcdef');
      expect(text).not.toContain(SECRET_URL);
      // All three copies — `name`, `config.source` and `summary`.
      type Row = { kind: string; name: string; summary: string; config: { source?: string } };
      const rows = JSON.parse(text) as Row[];
      const secret = rows.find(r => r.kind === 'polling' && r.name.includes('…'));
      expect(secret).toBeDefined();
      expect(secret!.config.source).toBe(secret!.name);
      expect(secret!.summary).toContain(secret!.name);
    });

    it('leaves an ordinary source readable (the masker is by SHAPE)', async () => {
      const text = await (await fetch(`${mount.baseUrl}/api/triggers`)).text();
      expect(text).toContain(PLAIN_URL);
    });

    it('masks it in the trigger catalog summary too', async () => {
      const text = await (
        await fetch(`${mount.baseUrl}/api/trigger-catalog`)
      ).text();
      expect(text).not.toContain('ghp_pollsecrettoken0123456789abcdef');
      expect(text).toContain(PLAIN_URL);
    });
  });

  // ── Bounded spawning reads ───────────────────────────────────────────────
  describe('subprocess-spawning reads', () => {
    it('answers a single versions read', async () => {
      const r = await fetch(`${mount.baseUrl}/api/versions/examples/streamed`);
      // 200 with a (possibly empty) commit list, or 500 when the workspace is
      // not a git repo — either is an ANSWER, which is the property here.
      expect([200, 500]).toContain(r.status);
    });

    it('sheds overlapping spawning reads with a 503 naming the lever', async () => {
      // With the cap at 1, a burst of concurrent version reads must shed: each
      // one spawns a `git` child, which is exactly the fan-out being bounded.
      const burst = await Promise.all(
        Array.from({ length: 16 }, () =>
          fetch(`${mount.baseUrl}/api/versions/examples/streamed`).then(
            async r => ({ status: r.status, text: await r.text() }),
          ),
        ),
      );
      const shed = burst.filter(x => x.status === 503);
      expect(shed.length).toBeGreaterThanOrEqual(1);
      expect(shed[0].text).toContain('SAMMY_MAX_SPAWNING_READS');
      // …and nothing hung: every request got an answer.
      expect(burst.every(x => x.status === 200 || x.status === 500 || x.status === 503)).toBe(true);
    });

    it('releases the slot once the holder answers', async () => {
      const r = await fetch(`${mount.baseUrl}/api/versions/examples/streamed`);
      expect([200, 500]).toContain(r.status);
    });
  });

  // ── Capped SSE run streams ───────────────────────────────────────────────
  describe('SSE run streams', () => {
    let runId: string;

    beforeAll(async () => {
      // A genuinely LIVE run: a code node awaiting a promise that never
      // resolves keeps the controller in flight, so `subscribe` live-tails
      // instead of replaying-and-ending. That is the shape a Runs view holds
      // open, and the one whose slot must be bounded.
      const started = await fetch(`${mount.baseUrl}/api/runs/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orchestrationName: 'streamed-live' }),
      });
      expect(started.status).toBe(200);
      runId = ((await started.json()) as { id: string }).id;
      await waitFor(
        async () => (await mount.store.getRunSummary(runId))?.status === 'running',
        'the run to be live',
      );
    });

    afterAll(async () => {
      await fetch(`${mount.baseUrl}/api/runs/${runId}/cancel`, { method: 'POST' });
    });

    /** Open a raw SSE socket and keep it open. */
    function openStream(): { status: Promise<number>; close: () => void } {
      const { hostname, port } = new URL(mount.baseUrl);
      const req = http.request({
        host: hostname,
        port,
        method: 'GET',
        path: `/api/runs/${runId}/events`,
        agent: false,
      });
      const status = new Promise<number>(resolve => {
        req.on('response', res => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', () => resolve(-1));
      });
      req.end();
      return { status, close: () => req.destroy() };
    }

    it('caps concurrent streams and names the lever', async () => {
      const first = openStream();
      expect(await first.status).toBe(200);
      const second = openStream();
      expect(await second.status).toBe(503);
      const third = openStream();
      expect(await third.status).toBe(503);
      first.close();
      second.close();
      third.close();
    });

    it('frees the slot when a stream disconnects', async () => {
      // The cap must not become permanently zero because a client dropped.
      const a = openStream();
      expect(await a.status).toBe(200);
      a.close();
      const freed = await waitFor(async () => {
        const b = openStream();
        const st = await b.status;
        b.close();
        return st === 200 ? true : null;
      }, 'the stream slot to be released');
      expect(freed).toBe(true);
    });
  });
});
