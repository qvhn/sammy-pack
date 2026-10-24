/**
 * What the API SHIPS of a run's orchestration snapshot vs. what the store
 * KEEPS.
 *
 * The snapshot pin attached the reachable closure — every raw agent body and
 * subflow tree — to the tree as `__pinned`. Resume needs it; nothing over
 * HTTP does. But GET /api/runs projected it per row, and two UI pollers
 * fetch the unbounded list every 4s: 50 rows measured 1.58MB, 150x the bare
 * trees. The LIST and the DETAIL now ship the bare tree only; the closure
 * stays in the store, and resume still pins (lifecycle-snapshot-pin).
 *
 * The mirror endpoint (POST /api/runs) had the opposite regression: it
 * stored `null` to refuse a CLIENT snapshot, which in the default in-browser
 * executor mode made Replay / Rerun vanish after the next poll. It now
 * stores the server's own copy of the named orchestration.
 *
 * And the orchestration SAVE strips `__pinned` beside `__origin`, so a
 * snapshot an editor round-trips cannot bake a stale closure into the file.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  getJson,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  postJson,
  putJson,
  startRun,
  waitForRun,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(60_000);

const ORCH = 'pinned-orch';
const AGENTS = ['agent-a', 'agent-b', 'agent-c'];
/** Big enough that the closure dwarfs the tree, as a real agent file does. */
const AGENT_BODY = 'You are a long prompt. '.repeat(1_000);

type Snapshot = { name?: string; __pinned?: { agents: Record<string, string> } };

describe('run snapshot projection', () => {
  let restoreEnv: () => void;
  let mount: Mount;
  let runId: string;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    const tmpRoot = await makeWorkspace('snapshot-projection');
    // Pauses at the first phase's lock, BEFORE any agent dispatches — so the
    // run exists, pinned, without the agents ever running.
    await writeOrchestration(tmpRoot, {
      name: ORCH,
      phases: [
        { name: 'gate', code: { source: "return 'g';" }, lock: true },
        ...AGENTS.map(a => ({ name: a, agent: `agents/${a}.md` })),
      ],
    });
    await fs.mkdir(path.join(tmpRoot, 'agents'), { recursive: true });
    for (const a of AGENTS) {
      await fs.writeFile(path.join(tmpRoot, 'agents', `${a}.md`), AGENT_BODY, 'utf8');
    }
    mount = await mountServer(tmpRoot);
    runId = (await startRun(mount.baseUrl, ORCH)).id!;
    await waitForRun(mount.baseUrl, runId, ['paused']);
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  it('the store keeps the pinned closure (resume needs it)', async () => {
    const stored = (await mount.store.getRun(runId))!.orchestrationSnapshot as Snapshot;
    expect(Object.keys(stored.__pinned!.agents).sort()).toEqual([...AGENTS].sort());
    expect(stored.__pinned!.agents['agent-a']).toBe(AGENT_BODY);
  });

  it('GET /api/runs ships the bare tree per row — no closure, under 2KB for a 3-agent run', async () => {
    const rows = await getJson<Array<{ id: string; orchestrationSnapshot?: Snapshot }>>(
      `${mount.baseUrl}/api/runs`,
    );
    const row = rows.find(r => r.id === runId)!;
    expect(row.orchestrationSnapshot?.name).toBe(ORCH);
    expect(row.orchestrationSnapshot).not.toHaveProperty('__pinned');
    expect(JSON.stringify(row).length).toBeLessThan(2_048);
  });

  it('GET /api/runs/:id ships the bare tree too (Replay diffs the tree, never the closure)', async () => {
    const run = await getJson<{ orchestrationSnapshot?: Snapshot }>(
      `${mount.baseUrl}/api/runs/${runId}`,
    );
    expect(run.orchestrationSnapshot?.name).toBe(ORCH);
    expect(run.orchestrationSnapshot).not.toHaveProperty('__pinned');
  });

  it('POST /api/runs (the mirror) stores the SERVER\'s snapshot, never the client\'s', async () => {
    const forged = { name: 'forged', phases: [{ name: 'pwn', code: { source: "return 'FORGED';" } }] };
    const { status, body } = await postJson<Record<string, unknown>>(`${mount.baseUrl}/api/runs`, {
      id: 'mirror-1',
      orchestrationName: ORCH,
      status: 'done',
      events: [],
      orchestrationSnapshot: forged,
    });
    expect(status).toBe(200);
    expect(body.orchestrationSnapshot).toBeUndefined();
    const stored = (await mount.store.getRun('mirror-1'))!.orchestrationSnapshot as Snapshot;
    // Pre-fix: null — and Replay / Rerun vanished from the UI on the next poll.
    expect(stored).not.toBeNull();
    expect(stored.name).toBe(ORCH);
    expect(JSON.stringify(stored)).not.toContain('FORGED');
    // The server's copy is a full pin, exactly as /runs/start stores.
    expect(Object.keys(stored.__pinned!.agents).sort()).toEqual([...AGENTS].sort());
  });

  it('a mirrored run for a name not in the workspace stores no snapshot (resumes by name)', async () => {
    await postJson(`${mount.baseUrl}/api/runs`, {
      id: 'mirror-2',
      orchestrationName: 'no-such-orch',
      status: 'done',
      events: [],
      orchestrationSnapshot: { name: 'no-such-orch', phases: [] },
    });
    expect((await mount.store.getRun('mirror-2'))!.orchestrationSnapshot).toBeNull();
  });

  it('PUT /api/orchestrations/:name strips __pinned (and __origin) before writing', async () => {
    const current = await getJson<Record<string, unknown>>(
      `${mount.baseUrl}/api/orchestrations/${ORCH}`,
    );
    const { status } = await putJson(`${mount.baseUrl}/api/orchestrations/${ORCH}`, {
      ...current,
      __origin: 'shipped',
      __pinned: { agents: { 'agent-a': 'STALE' }, orchestrations: {} },
    });
    expect(status).toBe(200);
    const onDisk = JSON.parse(
      await fs.readFile(path.join(mount.tmpRoot, 'examples', `${ORCH}.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(onDisk).not.toHaveProperty('__pinned');
    expect(onDisk).not.toHaveProperty('__origin');
    expect(onDisk.name).toBe(ORCH);
  });
});
