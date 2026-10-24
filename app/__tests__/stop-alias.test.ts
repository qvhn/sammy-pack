/**
 * POST /api/runs/:id/stop — exact alias of /cancel. Pinned because a
 * missing alias 405s the first verb an operator reaches for against a
 * wedged run, and that verb has to work. Also guards the /api/runs
 * pass-through allowlist, where a route not named in it 405s the same way.
 */

import {
  pinTestEnv,
  makeWorkspace,
  writeOrchestration,
  mountServer,
  startRun,
  waitForRun,
  postJson,
  type Mount,
} from './lifecycle-harness.helpers';

let restoreEnv: () => void;
beforeAll(() => {
  restoreEnv = pinTestEnv();
});
afterAll(() => {
  restoreEnv();
});

describe('POST /api/runs/:id/stop', () => {
  jest.setTimeout(20_000);

  test('stops a parked run exactly like /cancel; second stop reports terminal', async () => {
    const tmpRoot = await makeWorkspace('stop-alias');
    await writeOrchestration(tmpRoot, {
      name: 'parked',
      phases: [{ name: 'long-park', wait: { seconds: 3600 } }],
    });
    const m: Mount = await mountServer(tmpRoot);
    try {
      const { id } = await startRun(m.baseUrl, 'parked');
      await waitForRun(m.baseUrl, id!, ['paused']);

      const { status, body } = await postJson<Record<string, unknown>>(
        `${m.baseUrl}/api/runs/${id}/stop`,
      );
      expect(status).toBe(200); // pre-fix: 405 from the pass-through gap
      expect(body.ok).toBe(true);
      await waitForRun(m.baseUrl, id!, ['cancelled']);

      // Idempotent-ish repeat: already terminal → {ok:false, status}.
      const again = await postJson<Record<string, unknown>>(
        `${m.baseUrl}/api/runs/${id}/stop`,
      );
      expect(again.status).toBe(200);
      expect(again.body.ok).toBe(false);
    } finally {
      await m.kill();
    }
  });
});
