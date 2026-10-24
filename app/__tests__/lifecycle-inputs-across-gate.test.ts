/**
 * A run's declared inputs (resolved once, at start) must still resolve in a
 * leg that RESUMES — after an approval gate — not only in the phases before
 * it. Nothing re-resolves them, so they travel in the run's checkpoint.
 */
import { promises as fs } from 'node:fs';
import {
  approveGate,
  getRun,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  postJson,
  waitFor,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

describe('declared inputs across an approval gate', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await makeWorkspace('inputs-across-gate');
    await writeOrchestration(tmpRoot, {
      name: 'gated-input',
      inputs: [{ name: 'ticket', kind: 'text', required: true }],
      phases: [
        { name: 'before', code: { source: 'return "before:" + state.ticket' } },
        { name: 'after', lock: true, code: { source: 'return "after:" + state.ticket' } },
      ],
    });
    await writeOrchestration(tmpRoot, {
      name: 'queued-input',
      inputs: [{ name: 'ticket', kind: 'text', required: true }],
      concurrency: { group: 'one-at-a-time', policy: 'queue' },
      phases: [
        { name: 'hold', lock: true, code: { source: 'return "held"' } },
        { name: 'use', code: { source: 'return "used:" + state.ticket' } },
      ],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    restoreEnv();
  });

  const settled = (id: string, status: string) =>
    waitFor(async () => {
      const r = await getRun(mount.baseUrl, id);
      return r.status === status ? r : null;
    }, `run ${status}`, { timeoutMs: 25_000, intervalMs: 100 });

  it('the phase after the gate still sees the input', async () => {
    const { status, body } = await postJson<{ id: string }>(`${mount.baseUrl}/api/runs/start`, {
      orchestrationName: 'gated-input',
      inputs: { ticket: { value: 'ABC-1 fix the header' } },
    });
    expect(status).toBe(200);
    await settled(body.id, 'paused');
    await approveGate(mount.baseUrl, body.id);
    const run = await settled(body.id, 'done');
    expect(run.lastOutput).toBe('after:ABC-1 fix the header');
  });

  it('a start queued behind a busy group keeps its input when it is drained', async () => {
    const start = (ticket: string) =>
      postJson<{ id?: string; concurrency?: string }>(`${mount.baseUrl}/api/runs/start`, {
        orchestrationName: 'queued-input',
        inputs: { ticket: { value: ticket } },
      });
    const a = await start('FIRST');
    expect(a.status).toBe(200);
    await settled(a.body.id!, 'paused');
    const b = await start('SECOND');
    expect(b.body.concurrency).toBe('queued');
    // A finishes: its gate is approved, it runs to done, and the queue drains B.
    await approveGate(mount.baseUrl, a.body.id!);
    await settled(a.body.id!, 'done');
    const drained = await waitFor(async () => {
      const list = await (await fetch(`${mount.baseUrl}/api/runs`)).json() as Array<{ id: string; orchestrationName: string; status: string }>;
      return list.find(r => r.orchestrationName === 'queued-input' && r.id !== a.body.id && r.status === 'paused') ?? null;
    }, 'drained run paused', { timeoutMs: 25_000, intervalMs: 100 });
    await approveGate(mount.baseUrl, drained.id);
    const done = await settled(drained.id, 'done');
    expect(done.lastOutput).toBe('used:SECOND');
  });
});
