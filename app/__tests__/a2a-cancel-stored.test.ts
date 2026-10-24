/**
 * A2A `tasks/cancel` cancels a STORED task, not only a live one.
 *
 * The handler called the in-process `cancel(id)` and ignored its `false`
 * (no live controller), then returned the task as success. A task paused at
 * a gate — the ordinary state a remote agent would want to cancel — stayed
 * paused while the caller was told it was cancelled. It now mirrors the REST
 * route: live → abort; stored → the per-run-serialized store path; already
 * terminal → the protocol's TaskNotCancelable error.
 */

import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  startRun,
  waitForRun,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(45_000);

const ORCH = 'gated-orch';

type Rpc = {
  result?: { id: string; status: { state: string } };
  error?: { code: number; message: string };
};

describe('A2A tasks/cancel on a stored task', () => {
  let restoreEnv: () => void;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    const tmpRoot = await makeWorkspace('a2a-cancel-stored');
    await writeOrchestration(tmpRoot, {
      name: ORCH,
      phases: [
        { name: 'first', code: { source: "return 'one';" } },
        { name: 'gate', code: { source: "return 'two';" }, lock: true },
      ],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  async function rpc(method: string, params: Record<string, unknown>): Promise<Rpc> {
    const res = await fetch(`${mount.baseUrl}/api/a2a/${ORCH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await res.json()) as Rpc;
  }

  it('a task paused at a gate is actually cancelled', async () => {
    const { id } = await startRun(mount.baseUrl, ORCH);
    await waitForRun(mount.baseUrl, id!, ['paused']);

    const out = await rpc('tasks/cancel', { id });
    expect(out.error).toBeUndefined();
    expect(out.result?.status.state).toBe('canceled');
    const stored = await mount.store.getRun(id!);
    // Pre-fix: still `paused`, with a "success" on the wire.
    expect(stored!.status).toBe('cancelled');
    expect(stored!.events.filter(e => e.type === 'run-cancelled')).toHaveLength(1);
  });

  it('an already-terminal task answers TaskNotCancelable (-32002) with its status', async () => {
    const { id } = await startRun(mount.baseUrl, ORCH);
    await waitForRun(mount.baseUrl, id!, ['paused']);
    await rpc('tasks/cancel', { id });

    const again = await rpc('tasks/cancel', { id });
    expect(again.result).toBeUndefined();
    expect(again.error?.code).toBe(-32002);
    expect(again.error?.message).toContain('cancelled');
    // Idempotent on the store: one sentinel, no second terminal.
    expect(
      (await mount.store.getRun(id!))!.events.filter(e => e.type === 'run-cancelled'),
    ).toHaveLength(1);
  });
});
