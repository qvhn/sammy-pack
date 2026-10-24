/**
 * Lifecycle seams: RESUMED legs get full terminal parity with fresh starts.
 *
 * resume() used to relaunch the executor with NO budgetGate / onTerminal /
 * divergence — so any run that paused (human gate or durable wait) and then
 * finished via resume silently skipped everything the terminal hook owns:
 * `<orch>.done` event publishing (reactive chains), notify.onTerminal,
 * errorOrchestration recovery, the OTLP push, budget caps for the resumed
 * leg, and the concurrency-group drain of parked fires. Waits made
 * pause→resume the NORMAL lifecycle, promoting this from corner case to
 * mainline. These tests pin the fix on the real stack:
 *
 *   1. a gated run approved through its lock publishes `<orch>.done` into
 *      the durable delivery queue (a subscriber orchestration receives it)
 *   2. a run that completes via approve-resume drains the parked fire
 *      queued behind its concurrency group
 *   3. a signal-resumed wait leg publishes its terminal event the same way
 */

import {
  pinTestEnv,
  makeWorkspace,
  writeOrchestration,
  mountServer,
  startRun,
  approveGate,
  waitForRun,
  waitFor,
  getJson,
  postJson,
  listRuns,
  type Mount,
} from './lifecycle-harness.helpers';

let restoreEnv: () => void;
beforeAll(() => {
  restoreEnv = pinTestEnv();
});
afterAll(() => {
  restoreEnv();
});

/** True when some delivery row references the given event name. Shape-agnostic:
 *  rows are matched on their JSON text so field-name drift can't silently
 *  turn this assertion into a tautology. */
async function hasDeliveryFor(baseUrl: string, eventName: string): Promise<boolean> {
  const rows = await getJson<unknown[]>(`${baseUrl}/api/deliveries?limit=100`);
  return rows.some(r => JSON.stringify(r).includes(eventName));
}

describe('lifecycle: resumed legs keep the terminal machinery', () => {
  jest.setTimeout(30_000);

  test('approve-resume through a lock publishes <orch>.done to a subscriber', async () => {
    const tmpRoot = await makeWorkspace('resume-events');
    await writeOrchestration(tmpRoot, {
      name: 'gated-a',
      phases: [
        { name: 'review', lock: true, code: { source: "return 'approved-work'" } },
      ],
    });
    // Subscriber — registered at boot, so it must exist before the mount.
    await writeOrchestration(tmpRoot, {
      name: 'follow-b',
      triggers: [{ kind: 'events', event: 'gated-a.done' }],
      phases: [{ name: 'react', code: { source: "return 'reacted'" } }],
    });
    const m: Mount = await mountServer(tmpRoot);
    try {
      const { id } = await startRun(m.baseUrl, 'gated-a');
      await waitForRun(m.baseUrl, id!, ['paused']);
      // Before the fix: no delivery would EVER appear — the resumed leg
      // finished without the hook, so gated-a.done was never published.
      expect(await hasDeliveryFor(m.baseUrl, 'gated-a.done')).toBe(false);

      await approveGate(m.baseUrl, id!);
      await waitForRun(m.baseUrl, id!, ['done']);
      await waitFor(
        () => hasDeliveryFor(m.baseUrl, 'gated-a.done'),
        'gated-a.done delivery published by the resumed leg',
      );
    } finally {
      await m.kill();
    }
  });

  test('approve-resume completion drains the parked fire behind its concurrency group', async () => {
    const tmpRoot = await makeWorkspace('resume-drain');
    await writeOrchestration(tmpRoot, {
      name: 'grouped-c',
      concurrency: { group: 'resume-drain-group', policy: 'queue' },
      phases: [
        { name: 'review', lock: true, code: { source: "return 'ok'" } },
      ],
    });
    const m: Mount = await mountServer(tmpRoot);
    try {
      const first = await startRun(m.baseUrl, 'grouped-c');
      await waitForRun(m.baseUrl, first.id!, ['paused']);

      // Second fire parks behind the group held by the paused run.
      const second = await startRun(m.baseUrl, 'grouped-c');
      expect(second.id).toBeNull();
      expect(second.concurrency).toBe('queued');

      await approveGate(m.baseUrl, first.id!);
      await waitForRun(m.baseUrl, first.id!, ['done']);
      // Before the fix the parked fire stayed parked forever: the resumed
      // leg's terminal never ran releaseGroupAndDrainForRun. Now a second
      // run of grouped-c must appear (it pauses at its own gate — the
      // drain firing is the assertion, not its completion).
      await waitFor(async () => {
        const runs = await listRuns(m.baseUrl);
        return runs.filter(r => r.orchestrationName === 'grouped-c').length >= 2
          ? true
          : null;
      }, 'parked fire drained into a second grouped-c run');
    } finally {
      await m.kill();
    }
  });

  test('a signal-resumed wait leg publishes its terminal event too', async () => {
    const tmpRoot = await makeWorkspace('resume-wait-events');
    await writeOrchestration(tmpRoot, {
      name: 'waity-w',
      phases: [
        { name: 'gate', wait: { signal: 'go', timeoutSeconds: 3600 } },
        { name: 'after', code: { source: "return 'got:' + input" } },
      ],
    });
    await writeOrchestration(tmpRoot, {
      name: 'follow-w',
      triggers: [{ kind: 'events', event: 'waity-w.done' }],
      phases: [{ name: 'react', code: { source: "return 'reacted'" } }],
    });
    const m: Mount = await mountServer(tmpRoot);
    try {
      const { id } = await startRun(m.baseUrl, 'waity-w');
      await waitForRun(m.baseUrl, id!, ['paused']);

      const { status } = await postJson(`${m.baseUrl}/api/runs/${id}/signal`, {
        signal: 'go',
        payload: 'ship',
      });
      expect(status).toBe(200);
      await waitForRun(m.baseUrl, id!, ['done']);
      await waitFor(
        () => hasDeliveryFor(m.baseUrl, 'waity-w.done'),
        'waity-w.done delivery published by the signal-resumed leg',
      );
    } finally {
      await m.kill();
    }
  });
});
