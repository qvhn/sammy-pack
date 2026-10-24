/**
 * LIFECYCLE CASE 7 — INTERRUPTED-RUN RECOVERY.
 *
 * The crash the unit suite never staged end-to-end: a run row sits at status
 * 'running' in the store because its owning process died mid-run. On the next
 * boot the mount's orphan scan must transition it to 'interrupted' — a
 * TERMINAL, ACTIONABLE state (with a durable run-interrupted event explaining
 * why) — never leave it 'running' forever. And the recovery must actually
 * work: POST /:id/resume re-walks the tree, REPLAYS the checkpointed leaf,
 * and completes the run.
 *
 * The lease is the whole subtlety, so both halves are pinned:
 *   - a dead process's run = expired lease  → reclaimed at boot;
 *   - a LIVE peer's run   = fresh lease     → NOT stolen by the boot scan.
 *
 * The dead process is simulated with a seeding store whose leaseTtlMs is 1ms
 * (its lease is expired by the time the mount boots); the live peer with a
 * default-TTL store (2min lease, comfortably fresh). Auto-resume-on-boot
 * stays OFF (the harness env default), pinning the default recovery posture:
 * mark interrupted + leave it for a manual resume.
 */

import { promises as fs } from 'node:fs';
import { SqliteRunStore } from '../src/server/db';
import {
  cancelRun,
  eventsOfType,
  getRun,
  leafOutputs,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  resumeRun,
  sleep,
  waitForRun,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(30_000);

const ORCH = 'lifecycle-recover';
const CRASHED = 'lifecycle-crashed-run';
const LIVE = 'lifecycle-live-peer-run';
const SEEDED_OUT = 'SEEDED-step1-output';

describe('lifecycle: interrupted-run recovery at boot (case 7)', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv(); // SAMMY_AUTO_RESUME stays unset → mark-only
    tmpRoot = await makeWorkspace('recover');
    await writeOrchestration(tmpRoot, {
      name: ORCH,
      phases: [
        // Would mint a DIFFERENT marker if re-executed — replay-detectable.
        { name: 'step1', code: { source: "return 'fresh1-' + Math.random();" } },
        { name: 'step2', code: { source: "return 'step2:' + input;" } },
      ],
    });

    // ── The dead process: lease TTL 1ms → expired the moment it's written.
    const dead = new SqliteRunStore(tmpRoot, { leaseTtlMs: 1 });
    await dead.init();
    await dead.upsertRun({
      id: CRASHED,
      orchestrationName: ORCH,
      startedAt: Date.now() - 5_000,
      status: 'running', // ← crashed mid-run: still flagged running
      events: [
        { type: 'run-start', orchestrationName: ORCH, ts: Date.now() - 5_000 },
        {
          type: 'phase-start',
          phaseName: 'step1',
          agentPath: 'code',
          ts: Date.now() - 4_900,
        },
        {
          type: 'phase-end',
          phaseName: 'step1',
          replayKey: 'step1',
          output: SEEDED_OUT,
          ts: Date.now() - 4_800,
        },
        // …process died here, mid step2, with no terminal sentinel.
      ],
    });
    // The checkpoint the dead process had persisted before dying.
    await dead.updateRunStatus(CRASHED, {
      completedLeaves: ['step1'],
      lastOutput: SEEDED_OUT,
      stateJson: { leafOutputs: { step1: SEEDED_OUT } },
    });
    await dead.close();

    // ── The live peer: default TTL → its lease is fresh at boot time.
    const peer = new SqliteRunStore(tmpRoot);
    await peer.init();
    await peer.upsertRun({
      id: LIVE,
      orchestrationName: ORCH,
      startedAt: Date.now(),
      status: 'running',
      events: [{ type: 'run-start', orchestrationName: ORCH, ts: Date.now() }],
    });
    await peer.close();

    await sleep(25); // let the 1ms lease lapse unambiguously

    mount = await mountServer(tmpRoot); // ← the boot under test
  });

  afterAll(async () => {
    await mount.kill();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  it("the dead process's run is transitioned to 'interrupted' at boot — terminal + explained, not forever-'running'", async () => {
    const run = await getRun(mount.baseUrl, CRASHED);
    expect(run.status).toBe('interrupted');
    expect(run.endedAt).toBeGreaterThan(0); // actionable terminal, not limbo

    // The durable log says WHY.
    const marker = eventsOfType(run, 'run-interrupted');
    expect(marker.length).toBe(1);
    expect(String(marker[0].reason)).toMatch(/restart/i);
    expect(String(marker[0].reason)).toMatch(/interrupted/i);

    // The checkpoint survived the crash + reclaim.
    expect(run.completedLeaves).toEqual(['step1']);
    expect(leafOutputs(run).step1).toBe(SEEDED_OUT);
  });

  it("a LIVE peer's running run (fresh lease) is NOT stolen by the boot scan", async () => {
    const run = await getRun(mount.baseUrl, LIVE);
    expect(run.status).toBe('running'); // untouched — the peer owns it
    expect(eventsOfType(run, 'run-interrupted')).toEqual([]);
  });

  it('the interrupted run resumes through the API: checkpoint REPLAYED, remainder executed, run done', async () => {
    const res = await resumeRun(mount.baseUrl, CRASHED);
    expect(res).toMatchObject({ ok: true });

    const done = await waitForRun(mount.baseUrl, CRASHED, ['done']);
    const outs = leafOutputs(done);
    // step1 replayed the dead process's checkpoint (a re-execution would have
    // minted a fresh 'fresh1-…' marker instead).
    expect(outs.step1).toBe(SEEDED_OUT);
    // step2 executed for real, consuming the REPLAYED value.
    expect(outs.step2).toBe(`step2:${SEEDED_OUT}`);
    expect(done.lastOutput).toBe(`step2:${SEEDED_OUT}`);
    expect(done.events[done.events.length - 1].type).toBe('run-end');
    const types = done.events.map(e => e.type);
    expect(types).toContain('run-resumed');
  });

  it('housekeeping: the zombie live-peer run can still be cancelled through the API (no live controller path)', async () => {
    // Not part of the boot contract, but the operator story must close: a
    // running row whose owner is actually gone (fresh-lease window) is
    // cancellable from the Runs view rather than stuck.
    const res = await cancelRun(mount.baseUrl, LIVE);
    expect(res).toMatchObject({ ok: true, cancelled: true });
    expect((await getRun(mount.baseUrl, LIVE)).status).toBe('cancelled');
  });
});
