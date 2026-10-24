/**
 * The per-owner cap is operable: a refusal names the cap that bit, with that
 * cap's own figures and remedy, and Settings can change it.
 *
 * `budgetBlockedMessage` printed only the global figures and said "raise the
 * cap in Settings" whichever cap breached — so an owner over THEIR cap saw
 * workspace spend nowhere near the limit and a remedy that did not apply.
 * And PUT /api/budget forwarded only the global pair, so the per-owner caps
 * could not be changed from Settings at all. `evaluateBudget` now names the
 * breached caps; the message and the route are built on that.
 */

import { evaluateBudget } from '../src/server/budget-store';
import {
  getJson,
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

describe('evaluateBudget names the breached caps', () => {
  const cfg = { dailyUsd: 100, monthlyUsd: null, perOwnerDailyUsd: 1, perOwnerMonthlyUsd: null };

  it('empty when nothing is breached', () => {
    const s = evaluateBudget(cfg, { todayUsd: 10, monthUsd: 10 }, { todayUsd: 0.5, monthUsd: 0.5 });
    expect(s.blocked).toBe(false);
    expect(s.breached).toEqual([]);
  });

  it('the per-owner cap alone', () => {
    const s = evaluateBudget(cfg, { todayUsd: 10, monthUsd: 10 }, { todayUsd: 5, monthUsd: 5 });
    expect(s.blocked).toBe(true);
    expect(s.breached).toEqual(['ownerDaily']);
  });

  it('global and per-owner together, in cap order', () => {
    const s = evaluateBudget(cfg, { todayUsd: 100, monthUsd: 100 }, { todayUsd: 5, monthUsd: 5 });
    expect(s.breached).toEqual(['daily', 'ownerDaily']);
  });
});

describe('PUT /api/budget and the refusal message', () => {
  let restoreEnv: () => void;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    const tmpRoot = await makeWorkspace('budget-per-owner');
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

  const budget = () =>
    getJson<{ dailyUsd: number | null; perOwnerDailyUsd: number | null }>(
      `${mount.baseUrl}/api/budget`,
    );

  it('round-trips the per-owner caps: set, kept when absent, cleared by an explicit null', async () => {
    const set = await putJson<{ perOwnerDailyUsd: number | null }>(`${mount.baseUrl}/api/budget`, {
      dailyUsd: 100,
      perOwnerDailyUsd: 1,
    });
    expect(set.status).toBe(200);
    expect(set.body.perOwnerDailyUsd).toBe(1);
    expect((await budget()).perOwnerDailyUsd).toBe(1);

    // A client that only knows the global pair must not wipe it.
    await putJson(`${mount.baseUrl}/api/budget`, { dailyUsd: 100 });
    expect((await budget()).perOwnerDailyUsd).toBe(1);

    await putJson(`${mount.baseUrl}/api/budget`, { dailyUsd: 100, perOwnerDailyUsd: null });
    expect((await budget()).perOwnerDailyUsd).toBeNull();
  });

  it('a per-owner breach is refused with the OWNER\'s figures and the per-owner remedy', async () => {
    await putJson(`${mount.baseUrl}/api/budget`, { dailyUsd: 100, perOwnerDailyUsd: 1 });
    await mount.store.upsertRun({
      id: 'alice-spent',
      orchestrationName: ORCH,
      ownerId: 'alice',
      startedAt: Date.now(),
      endedAt: Date.now(),
      status: 'done',
      events: [{ type: 'phase-end', phaseName: 'p', output: 'x', costUsd: 5 }],
    });

    const refused = await postJson<{ error: string }>(
      `${mount.baseUrl}/api/runs/start`,
      { orchestrationName: ORCH },
      { 'x-sammy-user': 'alice' },
    );
    expect(refused.status).toBe(402);
    // Pre-fix: "Today: $5.00 / $100.00 … Raise the cap in Settings" — the
    // global figures, nowhere near their limit, and the wrong setting.
    expect(refused.body.error).toContain("this owner's daily cap");
    expect(refused.body.error).toContain('$5.00 / $1.00');
    expect(refused.body.error).toContain('per-owner cap in Settings');
    expect(refused.body.error).not.toContain('workspace daily cap');

    // Another owner is under their own cap and the global ceiling.
    const bob = await postJson(
      `${mount.baseUrl}/api/runs/start`,
      { orchestrationName: ORCH },
      { 'x-sammy-user': 'bob' },
    );
    expect(bob.status).toBe(200);
  });

  it('a global breach still names the workspace cap and the global remedy', async () => {
    await putJson(`${mount.baseUrl}/api/budget`, { dailyUsd: 1, perOwnerDailyUsd: null });
    const refused = await postJson<{ error: string }>(
      `${mount.baseUrl}/api/runs/start`,
      { orchestrationName: ORCH },
      { 'x-sammy-user': 'carol' },
    );
    expect(refused.status).toBe(402);
    expect(refused.body.error).toContain('the workspace daily cap');
    expect(refused.body.error).toContain('Raise the cap in Settings');
    expect(refused.body.error).not.toContain('per-owner');
  });
});
