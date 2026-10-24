import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  admitDelivery,
  calendarWindow,
  checkLimits,
  IntakePauseStore,
  PAUSE_RECHECK_MS,
  validateLimits,
} from '../src/server/admission';

const usageStore = (u: { runsToday: number; todayUsd: number; monthUsd: number }) => ({
  orchestrationUsage: jest.fn(async () => u),
});

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-admission-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('checkLimits', () => {
  const now = new Date(2026, 9, 23, 15, 0, 0).getTime();
  const w = calendarWindow(now);

  it('admits without limits, and does not query the store', async () => {
    const s = usageStore({ runsToday: 99, todayUsd: 99, monthUsd: 99 });
    expect(await checkLimits(s, 'o', undefined, now)).toEqual({ action: 'admit' });
    expect(await checkLimits(s, 'o', {}, now)).toEqual({ action: 'admit' });
    expect(s.orchestrationUsage).not.toHaveBeenCalled();
  });

  it('holds until tomorrow when the daily run cap is spent', async () => {
    const v = await checkLimits(usageStore({ runsToday: 5, todayUsd: 0, monthUsd: 0 }), 'o', { maxRunsPerDay: 5 }, now);
    expect(v).toMatchObject({ action: 'hold', until: w.nextDayStart });
    expect(v.action === 'hold' && v.reason).toMatch(/5 of 5 runs today/);
  });

  it('holds until next month when the monthly spend cap is spent', async () => {
    const v = await checkLimits(
      usageStore({ runsToday: 0, todayUsd: 0, monthUsd: 10 }),
      'o',
      { maxCostUsdPerMonth: 10, maxRunsPerDay: 100 },
      now,
    );
    expect(v).toMatchObject({ action: 'hold', until: w.nextMonthStart });
  });

  it('a limit of 0 means no trigger-fired runs', async () => {
    const v = await checkLimits(usageStore({ runsToday: 0, todayUsd: 0, monthUsd: 0 }), 'o', { maxRunsPerDay: 0 }, now);
    expect(v.action).toBe('hold');
  });

  it('admits under every cap', async () => {
    const v = await checkLimits(
      usageStore({ runsToday: 1, todayUsd: 1, monthUsd: 1 }),
      'o',
      { maxRunsPerDay: 2, maxCostUsdPerDay: 2, maxCostUsdPerMonth: 2 },
      now,
    );
    expect(v).toEqual({ action: 'admit' });
  });

  it('computes local calendar windows', () => {
    expect(new Date(w.dayStart).getHours()).toBe(0);
    expect(w.nextDayStart - w.dayStart).toBeGreaterThanOrEqual(23 * 3600_000);
    expect(new Date(w.nextMonthStart).getDate()).toBe(1);
    expect(new Date(w.nextMonthStart).getMonth()).toBe(10);
  });
});

describe('IntakePauseStore + admitDelivery', () => {
  const free = usageStore({ runsToday: 0, todayUsd: 0, monthUsd: 0 });

  it('round-trips pauses through the workspace file', async () => {
    const a = new IntakePauseStore(root);
    await a.pause('o1', { by: 'alice', reason: 'noisy' }, 123);
    await a.pause('o2', {});
    const b = new IntakePauseStore(root); // a second process
    expect(await b.get('o1')).toEqual({ pausedAt: 123, by: 'alice', reason: 'noisy' });
    expect(await b.resume('o1')).toBe(true);
    expect(await b.resume('o1')).toBe(false);
    expect(Object.keys(await a.list())).toEqual(['o2']);
  });

  it('does not treat inherited object keys as paused orchestrations', async () => {
    const s = new IntakePauseStore(root);
    expect(await s.get('constructor')).toBeNull();
    expect(await s.get('__proto__')).toBeNull();
  });

  it('serializes concurrent writes without losing one', async () => {
    const s = new IntakePauseStore(root);
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.pause(`o${i}`, {})));
    expect(Object.keys(await s.list())).toHaveLength(10);
  });

  it('treats a corrupt file as no pauses, loudly', async () => {
    await fs.writeFile(path.join(root, 'intake-pauses.json'), '{not json');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await new IntakePauseStore(root).list()).toEqual({});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refuses (never holds) a scheduled tick that is over a limit', async () => {
    const full = usageStore({ runsToday: 1, todayUsd: 0, monthUsd: 0 });
    const pauses = new IntakePauseStore(root);
    const base = { store: full, pauses, orchestrationName: 'o', limits: { maxRunsPerDay: 1 }, now: 1000 };
    expect((await admitDelivery({ ...base, kind: 'cron' })).action).toBe('refuse');
    expect((await admitDelivery({ ...base, kind: 'polling' })).action).toBe('refuse');
    expect((await admitDelivery({ ...base, kind: 'queue' })).action).toBe('hold');
  });

  it('holds HTTP-fired deliveries and refuses scheduled ticks while paused', async () => {
    const pauses = new IntakePauseStore(root);
    await pauses.pause('o', { by: 'bob' });
    const base = { store: free, pauses, orchestrationName: 'o', limits: undefined, now: 1000 };
    expect(await admitDelivery({ ...base, kind: 'queue' })).toEqual({
      action: 'hold',
      until: 1000 + PAUSE_RECHECK_MS,
      reason: 'intake for "o" is paused by bob',
    });
    const cron = await admitDelivery({ ...base, kind: 'cron' });
    expect(cron.action).toBe('refuse');
    await pauses.resume('o');
    expect(await admitDelivery({ ...base, kind: 'queue' })).toEqual({ action: 'admit' });
  });
});

describe('validateLimits', () => {
  it('accepts valid limits and rejects bad ones', () => {
    expect(validateLimits({ maxRunsPerDay: 5, maxCostUsdPerDay: 1.5, maxCostUsdPerMonth: 0 })).toEqual([]);
    expect(validateLimits({ maxRunsPerDay: 1.5 }).join()).toMatch(/non-negative integer/);
    expect(validateLimits({ maxCostUsdPerDay: -1 }).join()).toMatch(/non-negative number/);
    expect(validateLimits({ perHour: 1 }).join()).toMatch(/not a known limit/);
    expect(validateLimits([]).join()).toMatch(/must be an object/);
  });
});
