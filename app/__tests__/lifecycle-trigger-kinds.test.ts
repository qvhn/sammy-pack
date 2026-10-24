/**
 * END-TO-END TRIGGER COVERAGE — every one of the six kinds must actually
 * EXECUTE its orchestration.
 *
 * The coverage this closes: `trigger-kinds.test.ts` validates all six kinds
 * but only as registry/validation units, and `lifecycle-triggers.test.ts`
 * exercises exactly one kind (cron) end-to-end — and deliberately with the
 * delivery worker OFF, so its assertions stop at the durable `pending` row
 * ("accept ≠ execute"). Nothing proved that a webhook / events / deployment
 * / queue / polling fire reaches a RUN.
 *
 * So this suite runs the real stack with the in-process delivery worker
 * ENABLED (overriding the harness default) and, for each kind, asserts the
 * full path: fire → durable delivery → worker claim → run → `done`, with
 * the fire's own body arriving as the run's initial input. That last part
 * matters: a trigger that starts a run but drops its payload looks green
 * from the outside and is useless in practice.
 *
 * Determinism notes:
 *  - cron is fired by invoking the REAL registered task callback
 *    (`task.execute()`, what the scheduler itself calls) against a
 *    never-naturally-firing expression — same technique as case 6.
 *  - polling is driven by a local HTTP server this suite owns, so the
 *    "non-empty AND changed" condition is under test control rather than
 *    dependent on an external source.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import {
  destroySammyCronTasks,
  getJson,
  listRuns,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  postJson,
  sammyCronTasksNamed,
  waitFor,
  writeOrchestration,
  type Mount,
  type RunListEntry,
} from './lifecycle-harness.helpers';

jest.setTimeout(60_000);

/** Echoes the initial input so we can prove the payload survived the trip. */
const echoPhase = { name: 'echo', code: { source: "return 'fired:' + (input || '');" } };

const NEVER_FIRES = '0 4 * * *'; // daily 04:00 — never during a test run

type TriggerRow = { kind: string; name: string; orchestration: string; firing: string };

describe('lifecycle: all six trigger kinds execute their orchestration', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;
  let pollServer: http.Server;
  let pollUrl: string;
  /** Flipped per request so the polling source reads as "changed". */
  let pollBody = 'poll-payload-1';

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    // The harness pins the in-process worker OFF so deliveries stay
    // observable. This suite is specifically about delivery→RUN, so turn it
    // back on for this mount only (restoreEnv puts it back afterwards).
    delete process.env.SAMMY_DISABLE_INPROCESS_WORKER;

    // Local polling source, owned by the test.
    pollServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(pollBody);
    });
    await new Promise<void>(resolve => pollServer.listen(0, resolve));
    pollUrl = `http://127.0.0.1:${(pollServer.address() as AddressInfo).port}/feed`;

    tmpRoot = await makeWorkspace('trigger-kinds-e2e');
    await writeOrchestration(tmpRoot, {
      name: 'tk-webhook',
      triggers: [{ kind: 'webhook', path: 'tk-hook', method: 'POST' }],
      phases: [echoPhase],
    });
    await writeOrchestration(tmpRoot, {
      name: 'tk-events',
      triggers: [{ kind: 'events', event: 'tk.happened' }],
      phases: [echoPhase],
    });
    await writeOrchestration(tmpRoot, {
      name: 'tk-deployment',
      triggers: [{ kind: 'deployment', environment: 'tk-staging' }],
      phases: [echoPhase],
    });
    await writeOrchestration(tmpRoot, {
      name: 'tk-queue',
      triggers: [{ kind: 'queue', queue: 'tk-jobs' }],
      phases: [echoPhase],
    });
    await writeOrchestration(tmpRoot, {
      name: 'tk-cron',
      triggers: [{ kind: 'cron', expr: NEVER_FIRES }],
      phases: [echoPhase],
    });
    await writeOrchestration(tmpRoot, {
      name: 'tk-polling',
      triggers: [{ kind: 'polling', source: pollUrl, intervalSeconds: 1 }],
      phases: [echoPhase],
    });

    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    destroySammyCronTasks();
    await new Promise<void>(resolve => pollServer?.close(() => resolve()));
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  /** Wait for a completed run of `orch`, returning it. */
  const waitForDoneRun = (orch: string, label: string): Promise<RunListEntry> =>
    waitFor(async () => {
      const runs = (await listRuns(mount.baseUrl)).filter(
        r => r.orchestrationName === orch && r.status === 'done',
      );
      return runs[0] ?? null;
    }, label, { timeoutMs: 25_000, intervalMs: 100 });

  it('registers all six kinds at boot, with the right firing axis', async () => {
    const rows = (await getJson<TriggerRow[]>(`${mount.baseUrl}/api/triggers`)).filter(
      r => r.orchestration.startsWith('tk-'),
    );
    const byKind = new Map(rows.map(r => [r.kind, r]));
    expect([...byKind.keys()].sort()).toEqual([
      'cron',
      'deployment',
      'events',
      'polling',
      'queue',
      'webhook',
    ]);
    // HTTP-fired vs server-timer-fired, single-sourced from the kind registry.
    expect(byKind.get('webhook')!.firing).toBe('http');
    expect(byKind.get('events')!.firing).toBe('http');
    expect(byKind.get('deployment')!.firing).toBe('http');
    expect(byKind.get('queue')!.firing).toBe('http');
    expect(byKind.get('cron')!.firing).toBe('schedule');
    expect(byKind.get('polling')!.firing).toBe('schedule');
  });

  describe('HTTP ingress kinds', () => {
    const cases: Array<{ kind: string; path: string; orch: string; payload: string }> = [
      { kind: 'webhook', path: '/api/triggers/tk-hook', orch: 'tk-webhook', payload: 'hook-body' },
      { kind: 'events', path: '/api/events/tk.happened', orch: 'tk-events', payload: 'event-body' },
      { kind: 'deployment', path: '/api/deploy/tk-staging', orch: 'tk-deployment', payload: 'deploy-body' },
      { kind: 'queue', path: '/api/queue/tk-jobs', orch: 'tk-queue', payload: 'queue-body' },
    ];

    for (const c of cases) {
      it(`${c.kind}: POST ${c.path} runs the orchestration with the body as input`, async () => {
        const { status } = await postJson(`${mount.baseUrl}${c.path}`, c.payload);
        // 202 accepted (or 200 if the ingress dedupes an identical fire).
        expect([200, 202]).toContain(status);

        const run = await waitForDoneRun(c.orch, `${c.kind} fire → done run`);
        expect(run.status).toBe('done');
        // The payload must survive ingress → delivery → worker → executor.
        expect(run.initialInput ?? '').toContain(c.payload);
      });
    }

    it('an unregistered name is a 404, not a silent accept', async () => {
      const { status } = await postJson(
        `${mount.baseUrl}/api/events/tk.not-registered`,
        'x',
      );
      expect(status).toBe(404);
    });
  });

  describe('server-timer kinds', () => {
    it('cron: the REGISTERED task callback runs the orchestration', async () => {
      const [task] = sammyCronTasksNamed(`sammy:cron:tk-cron:${NEVER_FIRES}`);
      expect(task).toBeDefined();
      // Invoke exactly what the scheduler invokes on a tick.
      await task.execute!();
      const run = await waitForDoneRun('tk-cron', 'cron tick → done run');
      expect(run.status).toBe('done');
    });

    it('polling: a non-empty, changed source runs the orchestration', async () => {
      // The registration tick polls on its own schedule (1s here); the body
      // is non-empty and new, which is the fire condition.
      const run = await waitForDoneRun('tk-polling', 'polling tick → done run');
      expect(run.status).toBe('done');
      expect(run.initialInput ?? '').toContain('poll-payload');
    });
  });
});
