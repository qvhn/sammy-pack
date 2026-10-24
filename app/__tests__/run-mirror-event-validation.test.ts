/**
 * The mirror endpoint (POST /api/runs) validates the events it is handed.
 *
 * The mirror stored `events` verbatim, and every cost consumer — the two
 * SQL `costSummary` sums, `sumCostUsd`, the budget gate — folds `costUsd`
 * with no lower bound. So any write-capable caller could mirror a run
 * carrying `{type:'phase-end', costUsd:-N}` and reset their spend: a
 * 402'd owner mirrored a refund and the next /runs/start was 200. The
 * same unvalidated seam 500'd on `events:[null]` (the handler read `.type`
 * of null).
 *
 * Validated at this ONE ingestion seam and REFUSED (400), not zeroed: a
 * clamp in each sum would re-create the three-way parity burden the cost
 * sums already had, and would silently accept a bad write.
 */

import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  postJson,
  putJson,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(45_000);

const ORCH = 'plain-orch';

describe('POST /api/runs refuses malformed events', () => {
  let restoreEnv: () => void;
  let mount: Mount;
  let seq = 0;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    const tmpRoot = await makeWorkspace('mirror-events');
    await writeOrchestration(tmpRoot, {
      name: ORCH,
      phases: [{ name: 'p', code: { source: "return 'ok';" } }],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  /** Mirror a finished run with the given events, as `owner`. */
  async function mirror(
    owner: string,
    events: unknown,
    id?: string,
  ): Promise<{ status: number; id: string; error?: string }> {
    seq += 1;
    const runId = id ?? `${owner}-mirror-${seq}`;
    const { status, body } = await postJson<{ error?: string }>(
      `${mount.baseUrl}/api/runs`,
      { id: runId, orchestrationName: ORCH, status: 'done', events },
      { 'x-sammy-user': owner },
    );
    return { status, id: runId, error: body?.error };
  }

  const startAs = async (owner: string): Promise<number> =>
    (
      await postJson(
        `${mount.baseUrl}/api/runs/start`,
        { orchestrationName: ORCH },
        { 'x-sammy-user': owner },
      )
    ).status;

  it('a negative costUsd cannot un-breach the per-owner cap', async () => {
    expect(
      (await putJson(`${mount.baseUrl}/api/budget`, { dailyUsd: 100, perOwnerDailyUsd: 1 }))
        .status,
    ).toBe(200);
    // Spend past the cap through the mirror, as the cap's own population can.
    expect((await mirror('alice', [{ type: 'phase-end', phaseName: 'p', costUsd: 5 }])).status).toBe(
      200,
    );
    expect(await startAs('alice')).toBe(402);
    // The "refund": pre-fix stored verbatim → costSummary 0 → start 200.
    const refund = await mirror('alice', [{ type: 'phase-end', phaseName: 'p', costUsd: -5 }]);
    expect(refund.status).toBe(400);
    expect(refund.error).toContain('costUsd');
    expect(await mount.store.getRun(refund.id)).toBeNull();
    expect(await startAs('alice')).toBe(402);
  });

  it('refuses every non-finite / negative / non-numeric cost and token figure', async () => {
    for (const bad of [
      { type: 'phase-end', costUsd: '-5' },
      { type: 'phase-end', costUsd: -1e300 },
      { type: 'phase-error', costUsd: -0.01 },
      { type: 'phase-end', costUsd: 1, inputTokens: -1 },
      { type: 'phase-end', costUsd: 1, outputTokens: 'lots' },
    ]) {
      const r = await mirror('carol', [bad]);
      expect(`${JSON.stringify(bad)} → ${r.status}`).toBe(`${JSON.stringify(bad)} → 400`);
      expect(await mount.store.getRun(r.id)).toBeNull();
    }
  });

  it('refuses a non-object or typeless event with 400, not a 500', async () => {
    for (const events of [[null], [42], ['x'], [{}], [{ type: 7 }], [[]]]) {
      const r = await mirror('dave', events);
      expect(`${JSON.stringify(events)} → ${r.status}`).toBe(`${JSON.stringify(events)} → 400`);
      expect(await mount.store.getRun(r.id)).toBeNull();
    }
  });

  // ── The sum, not just the figure ─────────────────────────────────────────
  // Every case above asserts a PER-FIELD shape, which is exactly why the
  // accumulator was never covered: two separately-accepted finite costs made
  // the WORKSPACE daily total non-finite, after which every owner is 402'd
  // (even one who spent nothing), no finite cap can clear it, and the only
  // numeric surface answers `dailyUsed: null` beside `blocked: true`.
  it('two accepted costs cannot make the workspace total non-finite', async () => {
    expect(
      (await putJson(`${mount.baseUrl}/api/budget`, { dailyUsd: 1000 })).status,
    ).toBe(200);
    expect(await startAs('frank')).toBe(200);
    const poison = await mirror('mallory', [
      { type: 'phase-end', phaseName: 'p', costUsd: 1e308 },
      { type: 'phase-end', phaseName: 'p', costUsd: 1e308 },
    ]);
    expect(poison.status).toBe(400);
    expect(poison.error).toContain('costUsd');
    expect(await mount.store.getRun(poison.id)).toBeNull();
    // The figure survives as a number, so the cap still reports one.
    expect(Number.isFinite((await mount.store.costSummary()).todayUsd)).toBe(true);
    // …and an owner who never spent is not refused.
    expect(await startAs('frank')).toBe(200);
    const status = await fetch(`${mount.baseUrl}/api/budget/status`, {
      headers: { 'x-sammy-user': 'frank' },
    });
    expect(((await status.json()) as { dailyUsed: unknown }).dailyUsed).not.toBeNull();
  });

  it('bounds the figure per EVENT, so separate runs cannot sum past a double', async () => {
    // A per-POST guard would miss this: the SQL sums are cross-row.
    for (const id of ['cross-row-1', 'cross-row-2']) {
      const r = await mirror('mallory', [
        { type: 'phase-end', phaseName: 'p', costUsd: 1e308 },
      ], id);
      expect(`${id} → ${r.status}`).toBe(`${id} → 400`);
    }
    expect(Number.isFinite((await mount.store.costSummary()).todayUsd)).toBe(true);
    // The ceiling itself is the boundary: MAX_SAFE_INTEGER lands, one more does not.
    expect((await mirror('grace', [
      { type: 'phase-end', phaseName: 'p', inputTokens: Number.MAX_SAFE_INTEGER },
    ])).status).toBe(200);
    expect((await mirror('grace', [
      { type: 'phase-end', phaseName: 'p', inputTokens: Number.MAX_SAFE_INTEGER + 2 },
    ])).status).toBe(400);
  });

  it('a well-formed mirror still lands (zero and absent costs included)', async () => {
    const r = await mirror('erin', [
      { type: 'run-start', ts: Date.now() },
      { type: 'phase-end', phaseName: 'p', output: 'ok', costUsd: 0, inputTokens: 3, outputTokens: 1 },
      { type: 'phase-end', phaseName: 'q', output: 'ok' },
      { type: 'run-end', status: 'done' },
    ]);
    expect(r.status).toBe(200);
    const stored = await mount.store.getRun(r.id);
    expect(stored?.ownerId).toBe('erin');
    expect(stored?.events).toHaveLength(4);
    expect((await mount.store.costSummary('erin')).todayUsd).toBe(0);
  });
});
