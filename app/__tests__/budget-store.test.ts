/**
 * Server-side budget enforcement: config round-trip, spend evaluation,
 * the mid-run gate, and cost summing over the durable run store.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteRunStore } from '../src/server/db';
import {
  checkGateBreach,
  evaluateBudget,
  loadBudgetState,
  readBudgetConfig,
  writeBudgetConfig,
} from '../src/server/budget-store';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-budget-'));
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** The no-caps shape every reader returns for a missing / empty file. */
const NO_CAPS = {
  dailyUsd: null,
  monthlyUsd: null,
  perOwnerDailyUsd: null,
  perOwnerMonthlyUsd: null,
};

describe('budget config round-trip', () => {
  it('reads back what was written', async () => {
    const file = path.join(tmpRoot, 'budget.json');
    await writeBudgetConfig(file, { dailyUsd: 5, monthlyUsd: 100 });
    expect(await readBudgetConfig(file)).toEqual({
      ...NO_CAPS,
      dailyUsd: 5,
      monthlyUsd: 100,
    });
  });

  it('treats a missing file as no caps', async () => {
    expect(await readBudgetConfig(path.join(tmpRoot, 'nope.json'))).toEqual(
      NO_CAPS,
    );
  });

  it('sanitizes zero / negative / NaN limits to null', async () => {
    const file = path.join(tmpRoot, 'budget.json');
    const saved = await writeBudgetConfig(file, {
      dailyUsd: 0,
      monthlyUsd: -10,
    });
    expect(saved).toEqual(NO_CAPS);
    expect(await readBudgetConfig(file)).toEqual(NO_CAPS);
  });

  it('round-trips the per-owner caps', async () => {
    const file = path.join(tmpRoot, 'budget.json');
    await writeBudgetConfig(file, {
      dailyUsd: 50,
      monthlyUsd: null,
      perOwnerDailyUsd: 5,
      perOwnerMonthlyUsd: 40,
    });
    expect(await readBudgetConfig(file)).toEqual({
      dailyUsd: 50,
      monthlyUsd: null,
      perOwnerDailyUsd: 5,
      perOwnerMonthlyUsd: 40,
    });
  });

  it('a write that omits the per-owner fields keeps the file\'s values', async () => {
    // The budget PUT route only knows the two global fields. A Settings-page
    // save must not silently wipe an operator's file-configured per-owner
    // caps; an explicit `null` is how a caller clears one.
    const file = path.join(tmpRoot, 'budget.json');
    await writeBudgetConfig(file, {
      dailyUsd: 50,
      monthlyUsd: 500,
      perOwnerDailyUsd: 5,
      perOwnerMonthlyUsd: 40,
    });
    const saved = await writeBudgetConfig(file, { dailyUsd: 60, monthlyUsd: 600 });
    expect(saved).toEqual({
      dailyUsd: 60,
      monthlyUsd: 600,
      perOwnerDailyUsd: 5,
      perOwnerMonthlyUsd: 40,
    });
    const cleared = await writeBudgetConfig(file, {
      dailyUsd: 60,
      monthlyUsd: 600,
      perOwnerDailyUsd: null,
    });
    expect(cleared.perOwnerDailyUsd).toBeNull();
    expect(cleared.perOwnerMonthlyUsd).toBe(40);
  });
});

describe('evaluateBudget', () => {
  it('flags blocked at/over 100% of a limit', () => {
    const s = evaluateBudget(
      { dailyUsd: 10, monthlyUsd: null },
      { todayUsd: 10, monthUsd: 10 },
    );
    expect(s.blocked).toBe(true);
    expect(s.warning).toBe(true);
  });

  it('flags warning at 80% but not blocked', () => {
    const s = evaluateBudget(
      { dailyUsd: 10, monthlyUsd: null },
      { todayUsd: 8, monthUsd: 8 },
    );
    expect(s.blocked).toBe(false);
    expect(s.warning).toBe(true);
  });

  it('is clear when well under both caps', () => {
    const s = evaluateBudget(
      { dailyUsd: 10, monthlyUsd: 100 },
      { todayUsd: 1, monthUsd: 5 },
    );
    expect(s.blocked).toBe(false);
    expect(s.warning).toBe(false);
  });

  it('never blocks when no caps are set', () => {
    const s = evaluateBudget(
      { dailyUsd: null, monthlyUsd: null },
      { todayUsd: 9999, monthUsd: 9999 },
    );
    expect(s.blocked).toBe(false);
    expect(s.warning).toBe(false);
  });

  it('a monthly breach blocks even when daily is fine', () => {
    const s = evaluateBudget(
      { dailyUsd: 100, monthlyUsd: 50 },
      { todayUsd: 5, monthUsd: 50 },
    );
    expect(s.blocked).toBe(true);
  });

  it('the global ceiling is measured against UNSCOPED spend, not the owner\'s', () => {
    // The owner has spent nothing, but the workspace is at its ceiling.
    const s = evaluateBudget(
      { dailyUsd: 10, monthlyUsd: null },
      { todayUsd: 10, monthUsd: 10 },
      { todayUsd: 0, monthUsd: 0 },
    );
    expect(s.blocked).toBe(true);
    expect(s.dailyUsed).toBe(10);
    expect(s.ownerDailyUsed).toBe(0);
  });

  it('a per-owner cap is measured against the owner\'s spend only', () => {
    const cfg = { dailyUsd: 100, monthlyUsd: null, perOwnerDailyUsd: 5 };
    const workspace = { todayUsd: 20, monthUsd: 20 };
    const over = evaluateBudget(cfg, workspace, { todayUsd: 6, monthUsd: 6 });
    const under = evaluateBudget(cfg, workspace, { todayUsd: 1, monthUsd: 1 });
    expect(over.blocked).toBe(true);
    expect(under.blocked).toBe(false);
    expect(over.perOwnerDailyLimit).toBe(5);
  });

  it('a per-owner cap is NOT evaluated when there is no owner', () => {
    // The boot banner / worker direct path ask for the workspace-wide figure;
    // there is no owner to hold to a per-owner cap, so only the ceiling applies.
    const s = evaluateBudget(
      { dailyUsd: 100, monthlyUsd: null, perOwnerDailyUsd: 5 },
      { todayUsd: 20, monthUsd: 20 },
    );
    expect(s.blocked).toBe(false);
    expect(s.ownerDailyUsed).toBe(20);
  });
});

describe('checkGateBreach', () => {
  const gate = {
    dailyLimitUsd: 10,
    monthlyLimitUsd: 100,
    daySpentBeforeUsd: 8,
    monthSpentBeforeUsd: 40,
  };

  it('returns null when added cost stays under both caps', () => {
    expect(checkGateBreach(gate, 1)).toBeNull();
  });

  it('reports a daily breach when added cost crosses the day cap', () => {
    const reason = checkGateBreach(gate, 3);
    expect(reason).toMatch(/daily budget/);
  });

  it('reports a monthly breach', () => {
    const reason = checkGateBreach(
      { ...gate, dailyLimitUsd: null },
      70,
    );
    expect(reason).toMatch(/monthly budget/);
  });

  it('never breaches when no caps are set', () => {
    expect(
      checkGateBreach(
        {
          dailyLimitUsd: null,
          monthlyLimitUsd: null,
          daySpentBeforeUsd: 0,
          monthSpentBeforeUsd: 0,
        },
        1e6,
      ),
    ).toBeNull();
  });

  it('reports a per-owner breach while the global ceiling still has room', () => {
    const reason = checkGateBreach(
      {
        ...gate,
        perOwnerDailyLimitUsd: 3,
        perOwnerMonthlyLimitUsd: null,
        ownerDaySpentBeforeUsd: 2.5,
        ownerMonthSpentBeforeUsd: 2.5,
      },
      1,
    );
    expect(reason).toMatch(/per-owner daily budget/);
  });

  it('a per-owner limit on a gate built with no owner spend is inert', () => {
    // Defensive: the limit alone (no owner figure) can't be evaluated.
    expect(
      checkGateBreach({ ...gate, perOwnerDailyLimitUsd: 0.5 }, 1),
    ).toBeNull();
  });
});

describe('loadBudgetState — global ceiling vs per-owner cap', () => {
  const phaseEnd = (cost: number, ts: number) => ({
    type: 'phase-end',
    phaseName: 'p',
    output: 'x',
    costUsd: cost,
    ts,
  });
  const seedRun = (
    store: SqliteRunStore,
    id: string,
    ownerId: string,
    cost: number,
  ) =>
    store.upsertRun({
      id,
      orchestrationName: 'o',
      startedAt: Date.now(),
      status: 'done',
      ownerId,
      events: [phaseEnd(cost, Date.now())],
    });

  it('the global ceiling holds across rotating owners', async () => {
    // `dailyUsd` is the WORKSPACE ceiling. Two owners have spent it between
    // them; a brand-new owner id (the caller-chosen header, rotated) must
    // NOT mint a fresh full cap — that is what made exposure cap × owners.
    const store = new SqliteRunStore(tmpRoot);
    await store.init();
    const file = path.join(tmpRoot, 'budget.json');
    await writeBudgetConfig(file, { dailyUsd: 10, monthlyUsd: null });
    await seedRun(store, 'r-alice', 'alice', 6);
    await seedRun(store, 'r-bob', 'bob', 6);

    const fresh = await loadBudgetState(file, store, 'carol');
    expect(fresh.status.blocked).toBe(true);
    expect(fresh.status.dailyUsed).toBeCloseTo(12);
    expect(fresh.status.ownerDailyUsed).toBe(0);
    // The gate the controller halts on carries the unscoped figure too.
    expect(fresh.gate.daySpentBeforeUsd).toBeCloseTo(12);
    expect(checkGateBreach(fresh.gate, 0.01)).toMatch(/daily budget/);
    // And the unscoped (banner / worker) read agrees.
    expect((await loadBudgetState(file, store)).status.blocked).toBe(true);
    await store.close();
  });

  it('a per-owner cap blocks one owner without blocking another', async () => {
    const store = new SqliteRunStore(tmpRoot);
    await store.init();
    const file = path.join(tmpRoot, 'budget.json');
    await writeBudgetConfig(file, {
      dailyUsd: 100,
      monthlyUsd: null,
      perOwnerDailyUsd: 5,
    });
    await seedRun(store, 'r-alice', 'alice', 6);
    await seedRun(store, 'r-bob', 'bob', 1);

    const alice = await loadBudgetState(file, store, 'alice');
    const bob = await loadBudgetState(file, store, 'bob');
    expect(alice.status.blocked).toBe(true);
    expect(alice.status.ownerDailyUsed).toBeCloseTo(6);
    expect(bob.status.blocked).toBe(false);
    expect(bob.status.ownerDailyUsed).toBeCloseTo(1);
    // Both see the same workspace total against the (unbreached) ceiling.
    expect(alice.status.dailyUsed).toBeCloseTo(7);
    expect(bob.status.dailyUsed).toBeCloseTo(7);
    // Mid-run: bob's gate halts him once HIS spend would cross the cap, even
    // though the workspace ceiling is nowhere near.
    expect(checkGateBreach(bob.gate, 3)).toBeNull();
    expect(checkGateBreach(bob.gate, 4.5)).toMatch(/per-owner daily budget/);
    await store.close();
  });
});

describe('costSummary over the run store', () => {
  it('sums phase-end costUsd, bucketed by run start time', async () => {
    const store = new SqliteRunStore(tmpRoot);
    await store.init();
    const now = Date.now();
    const phaseEnd = (cost: number) => ({
      type: 'phase-end',
      phaseName: 'p',
      output: 'x',
      costUsd: cost,
      ts: now,
    });
    // Two runs started today.
    await store.upsertRun({
      id: 'today-1',
      orchestrationName: 'o',
      startedAt: now,
      status: 'done',
      events: [phaseEnd(1), phaseEnd(0.5)],
    });
    await store.upsertRun({
      id: 'today-2',
      orchestrationName: 'o',
      startedAt: now,
      status: 'done',
      events: [phaseEnd(2)],
    });
    // A run from ~40 days ago — before this month — must not count.
    await store.upsertRun({
      id: 'old',
      orchestrationName: 'o',
      startedAt: now - 40 * 24 * 60 * 60 * 1000,
      status: 'done',
      events: [phaseEnd(99)],
    });

    const summary = await store.costSummary();
    expect(summary.todayUsd).toBeCloseTo(3.5);
    expect(summary.monthUsd).toBeCloseTo(3.5);
    await store.close();
  });

  it('is zero for an empty store', async () => {
    const store = new SqliteRunStore(tmpRoot);
    await store.init();
    expect(await store.costSummary()).toEqual({ todayUsd: 0, monthUsd: 0 });
    await store.close();
  });
});
