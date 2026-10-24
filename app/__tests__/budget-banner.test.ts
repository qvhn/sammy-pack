/**
 * The Pipelines budget banner names the cap that is actually breached.
 *
 * GET /api/budget/status carries two caps: the global ceiling (measured
 * against workspace-wide `dailyUsed` / `monthlyUsed`) and the per-owner cap
 * (measured against the caller's `ownerDailyUsed` / `ownerMonthlyUsed`).
 * The banner printed only the global pair, so a per-owner breach rendered
 * "Budget exceeded:" over under-cap figures — or nothing at all when only
 * per-owner caps were configured.
 */

import {
  budgetBannerFigures,
  budgetBannerText,
  getBudgetStatus,
  saveBudgetConfig,
  type BudgetStatus,
} from '../src/store/budget';

const base: BudgetStatus = {
  dailyLimit: null,
  monthlyLimit: null,
  dailyUsed: 0,
  monthlyUsed: 0,
  perOwnerDailyLimit: null,
  perOwnerMonthlyLimit: null,
  ownerDailyUsed: 0,
  ownerMonthlyUsed: 0,
  blocked: false,
  warning: false,
};

describe('budgetBannerFigures', () => {
  it('names a per-owner breach while the global ceiling has room', () => {
    const s: BudgetStatus = {
      ...base,
      dailyLimit: 100,
      dailyUsed: 20,
      perOwnerDailyLimit: 5,
      ownerDailyUsed: 6,
      blocked: true,
      warning: true,
    };
    expect(budgetBannerFigures(s)).toEqual([
      { label: 'per-owner daily', used: 6, limit: 5 },
    ]);
    expect(budgetBannerText(s)).toBe('per-owner daily $6.00 / $5.00');
  });

  it('shows something when ONLY per-owner caps exist', () => {
    const s: BudgetStatus = {
      ...base,
      perOwnerMonthlyLimit: 40,
      ownerMonthlyUsed: 40,
      blocked: true,
      warning: true,
    };
    expect(budgetBannerText(s)).toBe('per-owner monthly $40.00 / $40.00');
  });

  it('lists every cap past the warning line, worst first', () => {
    const s: BudgetStatus = {
      ...base,
      dailyLimit: 5,
      dailyUsed: 4,
      monthlyLimit: 50,
      monthlyUsed: 10,
      perOwnerDailyLimit: 2,
      ownerDailyUsed: 2.5,
      blocked: true,
      warning: true,
    };
    expect(budgetBannerFigures(s).map(f => f.label)).toEqual([
      'per-owner daily',
      'daily',
    ]);
    expect(budgetBannerText(s)).toBe(
      'per-owner daily $2.50 / $2.00 · daily $4.00 / $5.00',
    );
  });

  it('is empty when nothing is near a cap', () => {
    expect(
      budgetBannerFigures({ ...base, dailyLimit: 10, dailyUsed: 1, perOwnerDailyLimit: 5 }),
    ).toEqual([]);
  });

  it('tolerates a status from a server that predates the per-owner fields', () => {
    const legacy = {
      dailyLimit: 5,
      monthlyLimit: null,
      dailyUsed: 5,
      monthlyUsed: 5,
      blocked: true,
      warning: true,
    } as unknown as BudgetStatus;
    expect(budgetBannerText(legacy)).toBe('daily $5.00 / $5.00');
  });
});

describe('budget client', () => {
  const g = globalThis as { fetch?: unknown };
  let prev: unknown;
  beforeEach(() => {
    prev = g.fetch;
  });
  afterEach(() => {
    g.fetch = prev;
  });

  it('surfaces the server text on a failed status read', async () => {
    g.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ error: 'A bearer token is required' }),
    }));
    await expect(getBudgetStatus()).rejects.toThrow(
      'GET /api/budget/status failed: 401 — A bearer token is required',
    );
  });

  it('sends explicit nulls for the per-owner caps (an omitted field keeps the file value)', async () => {
    let body = '';
    g.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
      body = String(init?.body ?? '');
      return { ok: true, status: 200, json: async () => JSON.parse(body) };
    });
    await saveBudgetConfig({
      dailyUsd: 5,
      monthlyUsd: null,
      perOwnerDailyUsd: 1,
      perOwnerMonthlyUsd: null,
    });
    expect(JSON.parse(body)).toEqual({
      dailyUsd: 5,
      monthlyUsd: null,
      perOwnerDailyUsd: 1,
      perOwnerMonthlyUsd: null,
    });
  });
});
