/**
 * LIFECYCLE CASE 1 — RESTART-WITH-PAUSED-RUN
 * LIFECYCLE CASE 8 — SSE/EVENTS AFTER RESTART
 *
 * The seam: a run snapshot+pauses at a `lock: true` gate, the server process
 * dies, a fresh process boots against the same runs.db. The paused run must
 * still be there (status intact), the gate must still be approvable through
 * the HTTP API, and the resumed re-walk must REPLAY the already-completed
 * phase from its checkpoint — not re-execute it. The durable event log must
 * survive the restart and keep appending.
 *
 * Everything real: mountSammyApi over connect+http (the serve.ts path), a
 * real SqliteRunStore in a temp workspace, the real executor. The workload is
 * pure `code.source` (vm) so no LLM/network is involved. The replay-vs-
 * re-execute side channel: the first phase's output embeds Date.now() +
 * Math.random() — a re-execution CANNOT reproduce it, a checkpoint replay
 * carries it verbatim (and feeds it to the downstream phase).
 */

import { promises as fs } from 'node:fs';
import {
  approveGate,
  eventsOfType,
  getRun,
  leafOutputs,
  listRuns,
  lockGateKeys,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  readEventStream,
  startRun,
  waitForRun,
  writeOrchestration,
  type ApiRun,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(30_000);

const ORCH = 'lifecycle-restart';

describe('lifecycle: restart with a paused run (case 1) + durable events (case 8)', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount1: Mount;
  let mount2: Mount | null = null;

  let runId: string;
  let seedOutputBefore: string;
  let eventCountBefore: number;
  let eventTypesBefore: string[];

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await makeWorkspace('restart');
    await writeOrchestration(tmpRoot, {
      name: ORCH,
      phases: [
        {
          name: 'seed',
          code: {
            // Non-reproducible marker: re-execution would change it.
            source: "return 'seed-' + Date.now() + '-' + Math.random();",
          },
        },
        {
          name: 'ship',
          lock: true, // ← the human gate the run pauses at
          code: { source: "return 'shipped:' + input;" },
        },
      ],
    });
    mount1 = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount1.kill();
    await mount2?.kill();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  it('runs phase 1 and snapshot-pauses at the lock gate', async () => {
    const started = await startRun(mount1.baseUrl, ORCH);
    expect(started.id).toBeTruthy();
    runId = started.id!;

    const paused = await waitForRun(mount1.baseUrl, runId, ['paused']);
    expect(paused.pausedFor).toBe('ship');
    // The API drops null columns: a paused run has no endedAt key.
    expect(paused.endedAt).toBeNull(); // not ended (explicit-null API contract)

    // Phase 1 completed + checkpointed with its non-reproducible marker.
    const outs = leafOutputs(paused);
    expect(outs.seed).toMatch(/^seed-\d+-0\.\d+/);
    seedOutputBefore = outs.seed;
    expect(paused.completedLeaves).toEqual(['seed']);

    // The gate is in the durable log.
    expect(lockGateKeys(paused)).toEqual(['ship']);
    const last = paused.events[paused.events.length - 1];
    expect(last.type).toBe('run-paused');
    eventCountBefore = paused.events.length;
    eventTypesBefore = paused.events.map(e => e.type);
  });

  it('survives a process death: re-mount over the SAME runs.db lists the paused run intact', async () => {
    // Simulated crash: controller memory dropped, socket + db handle closed.
    await mount1.kill();

    mount2 = await mountServer(tmpRoot);

    // The boot orphan-scan must NOT touch a paused run (it only reclaims
    // expired-lease `running` rows) — status + gate context are intact.
    const listed = await listRuns(mount2.baseUrl);
    const mine = listed.find(r => r.id === runId);
    expect(mine).toBeDefined();
    expect(mine!.status).toBe('paused');
    expect(mine!.pausedFor).toBe('ship');

    const full = await getRun(mount2.baseUrl, runId);
    expect(full.status).toBe('paused');
    expect(full.pausedFor).toBe('ship');
    expect(leafOutputs(full).seed).toBe(seedOutputBefore);
    expect(full.events.length).toBe(eventCountBefore);
  });

  it('approving the gate on the NEW process resumes and completes the run', async () => {
    const res = await approveGate(mount2!.baseUrl, runId);
    expect(res).toMatchObject({ ok: true, resumed: true, decision: 'approve' });

    const done = await waitForRun(mount2!.baseUrl, runId, ['done']);
    expect(done.pausedFor).toBeNull(); // cleared on resume (explicit-null API contract)
    expect(done.endedAt).toBeGreaterThan(0);
    expect(done.events[done.events.length - 1].type).toBe('run-end');
  });

  it('the earlier phase was REPLAYED, not re-executed (checkpoint output verbatim, fed downstream)', async () => {
    const done = await getRun(mount2!.baseUrl, runId);
    const outs = leafOutputs(done);

    // (a) The checkpoint value is byte-identical across the restart…
    expect(outs.seed).toBe(seedOutputBefore);
    // (b) …every phase-end 'seed' ever emitted (original pass + the resume's
    //     replay pass) carries that SAME output — a re-execution would have
    //     minted a fresh Date.now()/Math.random() marker.
    const seedEnds = eventsOfType(done, 'phase-end').filter(
      e => e.phaseName === 'seed',
    );
    expect(seedEnds.length).toBeGreaterThanOrEqual(2); // pass 1 + replay
    for (const e of seedEnds) expect(e.output).toBe(seedOutputBefore);
    // (c) …and the downstream gated phase consumed the REPLAYED value.
    expect(outs.ship).toBe(`shipped:${seedOutputBefore}`);
    expect(done.lastOutput).toBe(`shipped:${seedOutputBefore}`);
  });

  it('case 8: the SSE endpoint replays the durable log — pre-restart events intact, post-resume events appended, ts non-decreasing', async () => {
    const streamed = await readEventStream(mount2!.baseUrl, runId);
    const stored = (await getRun(mount2!.baseUrl, runId)) as ApiRun;

    // The SSE replay IS the durable log (same length, same type sequence).
    expect(streamed.length).toBe(stored.events.length);
    expect(streamed.map(e => e.type)).toEqual(stored.events.map(e => e.type));

    // Pre-restart prefix survived verbatim (the exact events written by the
    // dead process, in order).
    expect(streamed.slice(0, eventCountBefore).map(e => e.type)).toEqual(
      eventTypesBefore,
    );

    // Post-restart events APPENDED to the same log: the human's gate-decision,
    // the resume marker, and a terminal run-end.
    const post = streamed.slice(eventCountBefore).map(e => e.type);
    expect(post).toContain('gate-decision');
    expect(post).toContain('run-resumed');
    expect(post[post.length - 1]).toBe('run-end');

    // Timestamps never go backwards across the restart boundary.
    const tss = streamed
      .map(e => e.ts)
      .filter((t): t is number => typeof t === 'number');
    expect(tss.length).toBeGreaterThan(0);
    for (let i = 1; i < tss.length; i++) {
      expect(tss[i]).toBeGreaterThanOrEqual(tss[i - 1]);
    }
  });
});
