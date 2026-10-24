/** Cost guardrails — daily / monthly USD spend caps.
 *
 *  The caps and the spend total now live server-side: the caps in
 *  `budget.json` at the workspace root, the spend summed from the
 *  durable run store. That is what makes the cap actually enforced —
 *  `POST /api/runs/start` refuses a run once a cap is reached, so a
 *  direct API call can't sail past it the way it could when the cap
 *  was a client-only localStorage value.
 *
 *  Two caps (see `server/budget-store.ts`): the GLOBAL ceiling
 *  (`dailyUsd` / `monthlyUsd`), measured against the whole workspace's
 *  spend, and an optional PER-OWNER cap (`perOwnerDailyUsd` /
 *  `perOwnerMonthlyUsd`), measured against the calling owner's spend
 *  only. A run is refused when either breaches.
 *
 *  This module is the thin browser client for `GET`/`PUT /api/budget`
 *  and `GET /api/budget/status`. */

import { requestFailure } from '../api';

export type BudgetConfig = {
  dailyUsd: number | null;
  monthlyUsd: number | null;
  /** Per-owner caps. Optional on the wire: a field left `undefined` keeps
   *  the file's current value, an explicit `null` clears it — so the
   *  Settings form sends null for a blank field rather than omitting it. */
  perOwnerDailyUsd?: number | null;
  perOwnerMonthlyUsd?: number | null;
};

export type BudgetStatus = {
  /** The GLOBAL ceiling and the workspace-wide spend it is measured
   *  against. */
  dailyLimit: number | null;
  monthlyLimit: number | null;
  dailyUsed: number;
  monthlyUsed: number;
  /** The per-owner cap and the CALLER's own spend. The owner figures equal
   *  the workspace totals when the status was computed with no owner. */
  perOwnerDailyLimit: number | null;
  perOwnerMonthlyLimit: number | null;
  ownerDailyUsed: number;
  ownerMonthlyUsed: number;
  /** At or over 100% of ANY limit — the UI blocks new runs (the server
   *  refuses them regardless). */
  blocked: boolean;
  /** At or over 80% of any limit — the UI warns but still allows runs. */
  warning: boolean;
};

/** One cap of the four, with the spend it is measured against. */
export type BudgetCapFigure = {
  label: 'daily' | 'monthly' | 'per-owner daily' | 'per-owner monthly';
  used: number;
  limit: number;
};

/** The caps worth showing in a budget banner: every configured cap at or
 *  past the warning line (80%), worst first, so the banner names the cap
 *  that is actually breached. The old banner printed only the two global
 *  figures, so a per-owner breach rendered "Budget exceeded:" followed by
 *  under-cap numbers — or nothing when only per-owner caps existed. The
 *  threshold matches the server's `warning` flag; a status with neither
 *  flag set yields []. */
export function budgetBannerFigures(status: BudgetStatus): BudgetCapFigure[] {
  const caps: Array<[BudgetCapFigure['label'], number, number | null]> = [
    ['daily', status.dailyUsed, status.dailyLimit],
    ['monthly', status.monthlyUsed, status.monthlyLimit],
    ['per-owner daily', status.ownerDailyUsed ?? 0, status.perOwnerDailyLimit ?? null],
    ['per-owner monthly', status.ownerMonthlyUsed ?? 0, status.perOwnerMonthlyLimit ?? null],
  ];
  const out: BudgetCapFigure[] = [];
  for (const [label, used, limit] of caps) {
    if (limit == null || !(limit > 0)) continue;
    if (used / limit >= 0.8) out.push({ label, used, limit });
  }
  return out.sort((a, b) => b.used / b.limit - a.used / a.limit);
}

/** The banner's figures as text: `daily $4.10 / $5.00 · per-owner monthly
 *  $40.00 / $40.00`. */
export function budgetBannerText(status: BudgetStatus): string {
  return budgetBannerFigures(status)
    .map(f => `${f.label} $${f.used.toFixed(2)} / $${f.limit.toFixed(2)}`)
    .join(' · ');
}

export async function getBudgetConfig(): Promise<BudgetConfig> {
  const res = await fetch('/api/budget');
  if (!res.ok) throw await requestFailure('GET /api/budget', res);
  return (await res.json()) as BudgetConfig;
}

export async function saveBudgetConfig(
  cfg: BudgetConfig,
): Promise<BudgetConfig> {
  const res = await fetch('/api/budget', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) throw await requestFailure('PUT /api/budget', res);
  return (await res.json()) as BudgetConfig;
}

export async function getBudgetStatus(): Promise<BudgetStatus> {
  const res = await fetch('/api/budget/status');
  if (!res.ok) throw await requestFailure('GET /api/budget/status', res);
  return (await res.json()) as BudgetStatus;
}
