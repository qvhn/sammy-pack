/**
 * SIGNED TRIGGER INGRESS, END-TO-END.
 *
 * `webhook-auth.test.ts` tests the verifier thoroughly as a unit (legacy +
 * v2 schemes, tampering, tolerance, nonce replay). What nothing covered is
 * the WIRING: that declaring `signed: true` on a trigger actually makes the
 * mounted ingress enforce a signature. `SAMMY_WEBHOOK_SECRET` appeared in
 * zero test files, so both failure directions were unverified — a
 * locked-out trigger (correct signature rejected) and, worse, an endpoint
 * that advertises `signed` while accepting anything.
 *
 * Both directions are asserted here against the real server, and the
 * rejection case additionally proves NO run was started — a 401 that still
 * queues work would be the dangerous version of this bug.
 */

import { promises as fs } from 'node:fs';
import {
  destroySammyCronTasks,
  getJson,
  listRuns,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  postJson,
  waitFor,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';
import {
  signWebhookBody,
  signWebhookBodyV2,
} from '../src/server/webhook-auth';

jest.setTimeout(45_000);

const SECRET = 'trigger-ingress-secret';
/** The payload object, and the EXACT bytes the harness puts on the wire for
 *  it. The signature must cover the wire bytes — `postJson` JSON-stringifies
 *  its argument, so signing a hand-written string instead of
 *  `JSON.stringify(payload)` signs the wrong thing and the server correctly
 *  rejects it (how this test first failed). */
const PAYLOAD = { pr: 42 };
const BODY = JSON.stringify(PAYLOAD);

describe('lifecycle: signed trigger ingress is actually enforced', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    // Both of these are managed keys the harness clears, so they restore
    // cleanly: the shared HMAC secret, and the in-process worker (ON here
    // because an ACCEPTED fire must be shown to reach a run).
    process.env.SAMMY_WEBHOOK_SECRET = SECRET;
    delete process.env.SAMMY_DISABLE_INPROCESS_WORKER;

    tmpRoot = await makeWorkspace('signed-ingress');
    await writeOrchestration(tmpRoot, {
      name: 'sig-hook',
      triggers: [{ kind: 'webhook', path: 'sig-hook', method: 'POST', signed: true }],
      phases: [{ name: 'echo', code: { source: "return 'ok:' + (input || '');" } }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'sig-queue',
      triggers: [{ kind: 'queue', queue: 'sig-jobs', signed: true }],
      phases: [{ name: 'echo', code: { source: "return 'ok:' + (input || '');" } }],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    destroySammyCronTasks();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  const runsOf = async (orch: string): Promise<number> =>
    (await listRuns(mount.baseUrl)).filter(r => r.orchestrationName === orch).length;

  it('introspection reports the triggers as signed', async () => {
    const rows = await getJson<Array<{ orchestration: string; config: Record<string, unknown> }>>(
      `${mount.baseUrl}/api/triggers`,
    );
    const hook = rows.find(r => r.orchestration === 'sig-hook');
    expect(hook?.config.signed).toBe(true);
  });

  it('rejects an UNSIGNED fire and starts no run', async () => {
    const { status } = await postJson(`${mount.baseUrl}/api/triggers/sig-hook`, PAYLOAD);
    expect([401, 403]).toContain(status);
    // The dangerous failure mode would be "rejected, but queued anyway".
    await new Promise(r => setTimeout(r, 300));
    expect(await runsOf('sig-hook')).toBe(0);
  });

  it('rejects a fire signed with the WRONG secret', async () => {
    const { status } = await postJson(`${mount.baseUrl}/api/triggers/sig-hook`, PAYLOAD, {
      'x-sammy-signature': signWebhookBody(BODY, 'not-the-secret'),
    });
    expect([401, 403]).toContain(status);
    expect(await runsOf('sig-hook')).toBe(0);
  });

  it('rejects a VALID signature over a DIFFERENT body (tamper in flight)', async () => {
    // A signature valid for PAYLOAD, sent with a different body.
    const { status } = await postJson(`${mount.baseUrl}/api/triggers/sig-hook`, { pr: 99 }, {
      'x-sammy-signature': signWebhookBody(BODY, SECRET),
    });
    expect([401, 403]).toContain(status);
    expect(await runsOf('sig-hook')).toBe(0);
  });

  it('ACCEPTS a correctly-signed fire (legacy scheme) and runs the orchestration', async () => {
    const { status } = await postJson(`${mount.baseUrl}/api/triggers/sig-hook`, PAYLOAD, {
      'x-sammy-signature': signWebhookBody(BODY, SECRET),
    });
    expect([200, 202]).toContain(status);
    const run = await waitFor(
      async () =>
        (await listRuns(mount.baseUrl)).find(
          r => r.orchestrationName === 'sig-hook' && r.status === 'done',
        ) ?? null,
      'signed webhook → done run',
      { timeoutMs: 25_000, intervalMs: 100 },
    );
    expect(run.initialInput ?? '').toContain('"pr":42');
  });

  it('ACCEPTS a v2 (replay-protected) signature on a named queue trigger', async () => {
    const payload = { job: 'build' };
    const wire = JSON.stringify(payload);
    const { status } = await postJson(`${mount.baseUrl}/api/queue/sig-jobs`, payload, {
      'x-sammy-signature': signWebhookBodyV2(wire, SECRET, { nonce: 'ingress-1' }),
    });
    expect([200, 202]).toContain(status);
    await waitFor(
      async () =>
        (await listRuns(mount.baseUrl)).find(
          r => r.orchestrationName === 'sig-queue' && r.status === 'done',
        ) ?? null,
      'signed queue fire → done run',
      { timeoutMs: 25_000, intervalMs: 100 },
    );
  });
});
