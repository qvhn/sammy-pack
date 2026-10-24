/**
 * Lifecycle seams for DURABLE WAITS (`wait` body kind) — the real stack:
 * real mount, real SqliteRunStore, real executor over real HTTP.
 *
 *   1. a timer wait parks the run as status='paused' (zero-cost park), and a
 *      manual resume after the deadline completes it
 *   2. an EARLY manual resume re-parks against the ORIGINAL deadline — the
 *      clock is never re-armed (the wait-started events carry the same
 *      resumeAt across legs)
 *   3. POST /api/runs/:id/signal on a parked signal-wait resumes it
 *      immediately, payload → phase output → downstream input
 *   4. a signal delivered while the run is parked at an earlier LOCK gate
 *      buffers durably and is consumed when the wait is finally reached
 *      (and a lock pause does NOT leave a stale pendingWait for the sweeper)
 *   5. restart-during-wait: kill the mount mid-park, let the deadline pass,
 *      re-mount the same runs.db — the boot wait-sweep resumes the run to
 *      completion with no human action (the durable-timer contract)
 */

import {
  pinTestEnv,
  makeWorkspace,
  writeOrchestration,
  mountServer,
  startRun,
  approveGate,
  resumeRun,
  waitForRun,
  listRuns,
  eventsOfType,
  postJson,
  sleep,
  type Mount,
} from './lifecycle-harness.helpers';

let restoreEnv: () => void;
beforeAll(() => {
  restoreEnv = pinTestEnv();
});
afterAll(() => {
  restoreEnv();
});

describe('lifecycle: durable waits', () => {
  jest.setTimeout(30_000);

  test('timer wait parks the run; resume after the deadline completes it', async () => {
    const tmpRoot = await makeWorkspace('wait-timer');
    await writeOrchestration(tmpRoot, {
      name: 'wait-timer',
      phases: [
        { name: 'before', code: { source: "return 'pre'" } },
        { name: 'cool-down', wait: { seconds: 1 } },
        { name: 'after', code: { source: "return 'post:' + input" } },
      ],
    });
    const m: Mount = await mountServer(tmpRoot);
    try {
      const { id } = await startRun(m.baseUrl, 'wait-timer');
      const paused = await waitForRun(m.baseUrl, id!, ['paused']);
      expect(paused.pausedFor).toBe('cool-down');
      // The park is durable + explicit: a wait-started with the deadline.
      const started = eventsOfType(paused, 'wait-started');
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ kind: 'timer', durable: true });
      // The list payload exposes the park as `pendingWait`, which is what
      // lets the Approvals deck exclude it (not a human reviewable) and
      // the stale-gate sweeper skip it.
      const entry = (await listRuns(m.baseUrl)).find(r => r.id === id) as
        | { pendingWait?: { kind?: string } }
        | undefined;
      expect(entry?.pendingWait?.kind).toBe('timer');

      await sleep(1_100); // let the deadline pass
      await resumeRun(m.baseUrl, id!);
      const done = await waitForRun(m.baseUrl, id!, ['done']);
      expect(done.lastOutput).toMatch(/^post:/);
      expect(done.lastOutput).toContain('"waited":true');
    } finally {
      await m.kill();
    }
  });

  test('early resume re-parks against the ORIGINAL deadline (no re-arm)', async () => {
    const tmpRoot = await makeWorkspace('wait-rearm');
    await writeOrchestration(tmpRoot, {
      name: 'wait-rearm',
      phases: [{ name: 'long-park', wait: { seconds: 3600 } }],
    });
    const m: Mount = await mountServer(tmpRoot);
    try {
      const { id } = await startRun(m.baseUrl, 'wait-rearm');
      const paused1 = await waitForRun(m.baseUrl, id!, ['paused']);
      const firstStart = eventsOfType(paused1, 'wait-started')[0];

      await resumeRun(m.baseUrl, id!); // way too early — 1h out
      const paused2 = await waitForRun(
        m.baseUrl,
        id!,
        ['paused'],
        r => eventsOfType(r, 'wait-started').length >= 2,
        'run re-parked with a second wait-started',
      );
      const starts = eventsOfType(paused2, 'wait-started');
      // Same absolute deadline on both legs — a re-armed clock would move it.
      expect(starts[1].resumeAt).toBe(firstStart.resumeAt);
      expect(eventsOfType(paused2, 'run-resumed')).toHaveLength(1);
    } finally {
      await m.kill();
    }
  });

  test('signal delivery resumes a parked signal-wait; payload flows downstream', async () => {
    const tmpRoot = await makeWorkspace('wait-signal');
    await writeOrchestration(tmpRoot, {
      name: 'wait-signal',
      phases: [
        { name: 'gate', wait: { signal: 'go', timeoutSeconds: 3600 } },
        { name: 'after', code: { source: "return 'got:' + input" } },
      ],
    });
    const m: Mount = await mountServer(tmpRoot);
    try {
      const { id } = await startRun(m.baseUrl, 'wait-signal');
      await waitForRun(m.baseUrl, id!, ['paused']);

      const { status, body } = await postJson<{ resumed?: boolean }>(
        `${m.baseUrl}/api/runs/${id}/signal`,
        { signal: 'go', payload: { approved: true } },
      );
      expect(status).toBe(200);
      expect(body.resumed).toBe(true);

      const done = await waitForRun(m.baseUrl, id!, ['done']);
      // Non-string payload is JSON-stringified; it IS the wait's output.
      expect(done.lastOutput).toBe('got:{"approved":true}');
      expect(eventsOfType(done, 'signal-received')).toHaveLength(1);
    } finally {
      await m.kill();
    }
  });

  test('the approval-gate endpoint refuses a run parked on a wait', async () => {
    const tmpRoot = await makeWorkspace('wait-not-a-gate');
    await writeOrchestration(tmpRoot, {
      name: 'wait-not-a-gate',
      phases: [{ name: 'gate', wait: { signal: 'go', timeoutSeconds: 3600 } }],
    });
    const m: Mount = await mountServer(tmpRoot);
    try {
      const { id } = await startRun(m.baseUrl, 'wait-not-a-gate');
      await waitForRun(m.baseUrl, id!, ['paused']);
      const { status, body } = await postJson<{ error?: string }>(`${m.baseUrl}/api/runs/${id}/gate`, {
        decision: 'approve',
      });
      expect(status).toBe(409);
      expect(body.error).toMatch(/waiting at "gate" for a timer or signal/);
    } finally {
      await m.kill();
    }
  });

  test('a signal delivered while parked at an earlier LOCK buffers durably until the wait', async () => {
    const tmpRoot = await makeWorkspace('wait-buffered');
    await writeOrchestration(tmpRoot, {
      name: 'wait-buffered',
      phases: [
        {
          name: 'review',
          lock: true,
          code: { source: "return 'reviewed'" },
        },
        { name: 'gate', wait: { signal: 'go', timeoutSeconds: 3600 } },
        { name: 'after', code: { source: "return 'got:' + input" } },
      ],
    });
    const m: Mount = await mountServer(tmpRoot);
    try {
      const { id } = await startRun(m.baseUrl, 'wait-buffered');
      await waitForRun(m.baseUrl, id!, ['paused'], r => r.pausedFor === 'review');

      // Deliver while the run is parked at the LOCK — nothing is waiting on
      // the signal yet. The endpoint must buffer (resumed:false), and the
      // lock pause must NOT look like a signal wait to the sweeper.
      const { body } = await postJson<{ resumed?: boolean }>(
        `${m.baseUrl}/api/runs/${id}/signal`,
        { signal: 'go', payload: 'early-bird' },
      );
      expect(body.resumed).toBe(false);

      await approveGate(m.baseUrl, id!);
      // The wait consumes the buffered delivery on its first crossing — the
      // run must reach done WITHOUT ever parking on the signal.
      const done = await waitForRun(m.baseUrl, id!, ['done']);
      expect(done.lastOutput).toBe('got:early-bird');
      expect(
        eventsOfType(done, 'wait-started').filter(e => e.kind === 'signal'),
      ).toHaveLength(0);
    } finally {
      await m.kill();
    }
  });

  test('restart during a timer wait: the boot sweep resumes it with no human action', async () => {
    const tmpRoot = await makeWorkspace('wait-restart');
    await writeOrchestration(tmpRoot, {
      name: 'wait-restart',
      phases: [
        { name: 'before', code: { source: "return 'pre'" } },
        { name: 'cool-down', wait: { seconds: 1 } },
        { name: 'after', code: { source: "return 'survived:' + input" } },
      ],
    });
    let m: Mount = await mountServer(tmpRoot);
    const { id } = await startRun(m.baseUrl, 'wait-restart');
    await waitForRun(m.baseUrl, id!, ['paused']);
    await m.kill(); // process death while parked

    await sleep(1_200); // the deadline passes while the server is down

    m = await mountServer(tmpRoot); // restart against the same runs.db
    try {
      // No resume call, no signal — the boot wait-sweep must find the due
      // timer in stateJson.pendingWait and resume the run by itself.
      const done = await waitForRun(
        m.baseUrl,
        id!,
        ['done'],
        undefined,
        'boot sweep auto-resumed the parked wait',
      );
      expect(done.lastOutput).toMatch(/^survived:/);
      expect(eventsOfType(done, 'run-resumed')).toHaveLength(1);
    } finally {
      await m.kill();
    }
  });
});
