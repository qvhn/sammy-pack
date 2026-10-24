/**
 * Lifecycle seams for rerun feedback, on the real
 * stack (real mount, real SQLite, real executor over HTTP):
 *
 *   1. resume-from-error replays completed leaves — the expensive phase is
 *      NOT repaid (its output is byte-identical across legs), and the run
 *      re-executes from the failed phase
 *   2. an errored run whose concurrency group has since been taken is
 *      REFUSED resume (its terminal released the group)
 *   3. an external signal kill (exit 143) lands as `interrupted`, not
 *      `error` — and is resumable in one click
 */

import {
  pinTestEnv,
  makeWorkspace,
  writeOrchestration,
  mountServer,
  startRun,
  waitForRun,
  resumeRun,
  postJson,
  eventsOfType,
  type Mount,
} from './lifecycle-harness.helpers';

let restoreEnv: () => void;
beforeAll(() => {
  restoreEnv = pinTestEnv();
});
afterAll(() => {
  restoreEnv();
});

describe('lifecycle: resume-from-error + signal-kill classification', () => {
  jest.setTimeout(30_000);

  test('resume-from-error replays the completed leaf instead of re-running it', async () => {
    const tmpRoot = await makeWorkspace('resume-error');
    await writeOrchestration(tmpRoot, {
      name: 'pricey-then-boom',
      phases: [
        // Random marker: a RE-RUN would produce a different output; a
        // checkpoint REPLAY reproduces the first leg's byte-for-byte.
        { name: 'pricey', code: { source: "return 'A-' + Math.random()" } },
        { name: 'boom', code: { source: "throw new Error('boom')" } },
      ],
    });
    const m: Mount = await mountServer(tmpRoot);
    try {
      const { id } = await startRun(m.baseUrl, 'pricey-then-boom');
      const errored = await waitForRun(m.baseUrl, id!, ['error']);
      const firstOut = eventsOfType(errored, 'phase-end').find(
        e => e.phaseName === 'pricey',
      )?.output as string;
      expect(firstOut).toMatch(/^A-/);

      // One-click retry of the SAME run — previously a 409 dead end.
      await resumeRun(m.baseUrl, id!);
      const again = await waitForRun(
        m.baseUrl,
        id!,
        ['error'],
        r => eventsOfType(r, 'run-resumed').length === 1,
        'second error terminal after resume',
      );
      const priceyEnds = eventsOfType(again, 'phase-end').filter(
        e => e.phaseName === 'pricey',
      );
      // Two phase-ends (real run + zero-cost replay) with IDENTICAL output —
      // the expensive leaf was replayed, not repaid.
      expect(priceyEnds).toHaveLength(2);
      expect(priceyEnds[1].output).toBe(firstOut);
      // …and the failed phase genuinely re-executed (a fresh phase-error).
      expect(
        eventsOfType(again, 'phase-error').filter(e => e.phaseName === 'boom')
          .length,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      await m.kill();
    }
  });

  test('resume-from-error is refused while another run holds the freed group', async () => {
    const tmpRoot = await makeWorkspace('resume-error-group');
    await writeOrchestration(tmpRoot, {
      name: 'grouped-boom',
      concurrency: { group: 'resume-error-group', policy: 'queue' },
      phases: [{ name: 'boom', code: { source: "throw new Error('boom')" } }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'grouped-parker',
      concurrency: { group: 'resume-error-group', policy: 'queue' },
      phases: [{ name: 'park', wait: { seconds: 3600 } }],
    });
    const m: Mount = await mountServer(tmpRoot);
    try {
      const boom = await startRun(m.baseUrl, 'grouped-boom');
      await waitForRun(m.baseUrl, boom.id!, ['error']); // group released

      const parker = await startRun(m.baseUrl, 'grouped-parker');
      await waitForRun(m.baseUrl, parker.id!, ['paused']); // group now held

      const { status, body } = await postJson<{ error?: string }>(
        `${m.baseUrl}/api/runs/${boom.id}/resume`,
      );
      expect(status).toBe(409);
      expect(String(body.error)).toContain('resume-error-group');
      expect(String(body.error)).toContain(parker.id!);
    } finally {
      await m.kill();
    }
  });

  test('an external SIGTERM kill lands as interrupted (resumable), not error', async () => {
    const tmpRoot = await makeWorkspace('signal-kill');
    await writeOrchestration(tmpRoot, {
      name: 'killed',
      phases: [
        {
          name: 'victim',
          code: {
            source:
              "throw new Error('Claude Code process exited with code 143')",
          },
        },
      ],
    });
    const m: Mount = await mountServer(tmpRoot);
    try {
      const { id } = await startRun(m.baseUrl, 'killed');
      // Pre-fix this landed `error` — a dead end. Now: `interrupted`.
      const run = await waitForRun(m.baseUrl, id!, ['interrupted']);
      expect(run.status).toBe('interrupted');
      // …and resume accepts it in one click (the phase re-runs and gets
      // killed again in this synthetic repro; acceptance is the 200).
      const res = await resumeRun(m.baseUrl, id!);
      expect(res.ok).toBe(true);
      await waitForRun(
        m.baseUrl,
        id!,
        ['interrupted'],
        r => eventsOfType(r, 'run-resumed').length === 1,
      );
    } finally {
      await m.kill();
    }
  });
});
