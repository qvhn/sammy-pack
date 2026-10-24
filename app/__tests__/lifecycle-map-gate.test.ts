/**
 * LIFECYCLE CASE 2 — GATE-RESUME INSIDE A SERIAL MAP.
 *
 * A serial `map` over 3 items whose body holds a `lock: true` gate. The gate's
 * DISPLAY name is identical across iterations, but each iteration's lock is a
 * distinct instance keyed by the iteration-scoped replayKey
 * (`<map>[<idx>]/<gate>`). The historical regression: resume auto-approved by
 * the BARE name, iteration 0's re-walked gate consumed the entry, and the run
 * re-paused at iteration 0 forever — approve #1 never reached item 1.
 *
 * This drives the REAL executor through the REAL HTTP gate endpoint (no
 * stubbed event sources — the run-controller unit tests already stub; here the
 * executor's own lock decorator + replay machinery are under test):
 *   approve #1 → item 0 executes, run pauses at item 1's gate (NOT item 0);
 *   approve #2 → item 0 REPLAYS byte-identical, item 1 executes, pause at 2;
 *   approve #3 → run completes; three DISTINCT scoped gate keys in the log.
 */

import { promises as fs } from 'node:fs';
import {
  approveGate,
  leafOutputs,
  lockGateKeys,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  startRun,
  waitForRun,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(30_000);

const ORCH = 'lifecycle-map-gate';
const MAP = 'per-item';
const GATE = 'gated-step';
const scoped = (idx: number) => `${MAP}[${idx}]/${GATE}`;

describe('lifecycle: per-iteration lock gates in a serial map (case 2)', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;
  let runId: string;
  let out0: string;
  let out1: string;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await makeWorkspace('mapgate');
    await writeOrchestration(tmpRoot, {
      name: ORCH,
      phases: [
        {
          name: MAP,
          map: {
            over: '["alpha","beta","gamma"]',
            serial: true,
            body: {
              name: GATE,
              lock: true, // ← a human gate per iteration
              code: {
                // Per-item + non-reproducible: replay-vs-re-run detectable.
                source: "return 'done-' + item + '-' + Math.random();",
              },
            },
          },
        },
      ],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount.kill();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  it("pauses at item 0's gate with the iteration-scoped replayKey", async () => {
    const started = await startRun(mount.baseUrl, ORCH);
    expect(started.id).toBeTruthy();
    runId = started.id!;

    const paused = await waitForRun(mount.baseUrl, runId, ['paused']);
    // pausedFor keeps the bare display name (the UI contract)…
    expect(paused.pausedFor).toBe(GATE);
    // …while the gate's per-iteration identity rides the lock-gate event.
    expect(lockGateKeys(paused)).toEqual([scoped(0)]);
    // Nothing has executed yet — the lock gates BEFORE dispatch.
    expect(leafOutputs(paused)[scoped(0)]).toBeUndefined();
  });

  it('approve #1 → item 0 executes and the run pauses at item 1 (does NOT re-pause at item 0)', async () => {
    await approveGate(mount.baseUrl, runId);

    // Race-free re-pause detection: paused AND item-1's gate event exists.
    const paused = await waitForRun(
      mount.baseUrl,
      runId,
      ['paused'],
      r => lockGateKeys(r).includes(scoped(1)),
      'paused at item 1 gate',
    );
    const keys = lockGateKeys(paused);
    // The NEWEST gate crossing is iteration 1's — the run moved FORWARD.
    expect(keys[keys.length - 1]).toBe(scoped(1));
    // Item 0's work actually ran and checkpointed under its scoped key.
    out0 = leafOutputs(paused)[scoped(0)];
    expect(out0).toMatch(/^done-alpha-0\.\d+/);
    // Item 1 has not run.
    expect(leafOutputs(paused)[scoped(1)]).toBeUndefined();
  });

  it('approve #2 → item 0 REPLAYS byte-identical, item 1 executes, pause at item 2', async () => {
    await approveGate(mount.baseUrl, runId);

    const paused = await waitForRun(
      mount.baseUrl,
      runId,
      ['paused'],
      r => lockGateKeys(r).includes(scoped(2)),
      'paused at item 2 gate',
    );
    const outs = leafOutputs(paused);
    // Replay, not re-execution: the Math.random() marker is verbatim.
    expect(outs[scoped(0)]).toBe(out0);
    out1 = outs[scoped(1)];
    expect(out1).toMatch(/^done-beta-0\.\d+/);
    expect(out1).not.toBe(out0);
    const keys = lockGateKeys(paused);
    expect(keys[keys.length - 1]).toBe(scoped(2));
    expect(outs[scoped(2)]).toBeUndefined();
  });

  it('approve #3 → the run completes; every iteration kept its own gate + output', async () => {
    await approveGate(mount.baseUrl, runId);

    const done = await waitForRun(mount.baseUrl, runId, ['done']);
    expect(done.pausedFor).toBeNull(); // explicit-null API contract
    expect(done.events[done.events.length - 1].type).toBe('run-end');

    const outs = leafOutputs(done);
    expect(outs[scoped(0)]).toBe(out0); // still the original execution
    expect(outs[scoped(1)]).toBe(out1); // replayed through pass 3
    expect(outs[scoped(2)]).toMatch(/^done-gamma-0\.\d+/);

    // Each iteration's gate is a DISTINCT instance: exactly the three scoped
    // keys, never a bare-name collapse.
    const distinct = new Set(lockGateKeys(done));
    expect(distinct).toEqual(new Set([scoped(0), scoped(1), scoped(2)]));

    // 3 approvals for 3 items — one human decision per iteration.
    const decisions = done.events.filter(e => e.type === 'gate-decision');
    expect(decisions.length).toBe(3);
  });
});
