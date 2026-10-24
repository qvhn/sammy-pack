/**
 * Server-side spend caps. The daily / monthly USD budget lives in
 * `<repoRoot>/budget.json` (one workspace = one budget), and current
 * spend is summed from the durable run store. This is what makes the
 * cap actually enforceable: the run-controller refuses to start a run
 * when the cap is already reached, and halts a long run that crosses
 * it mid-flight. The old client-side localStorage cap could only grey
 * out a button — a direct API call sailed straight past it.
 *
 * ── Two caps, and which spend each is measured against ───────────────────
 *
 *   `dailyUsd` / `monthlyUsd`                 — the GLOBAL ceiling. Evaluated
 *                                               against UNSCOPED spend: every
 *                                               run in the store, whoever
 *                                               owns it.
 *   `perOwnerDailyUsd` / `perOwnerMonthlyUsd` — a per-owner cap. Evaluated
 *                                               against THAT owner's spend
 *                                               only. Optional; absent = no
 *                                               per-owner cap.
 *
 * A run is refused (and halted mid-flight) when EITHER breaches. The two are
 * independent: a per-owner cap never raises the global ceiling, and the global
 * ceiling never excuses an owner who is over their own cap.
 *
 * Why both exist. The cap was originally workspace-global, so on a shared
 * deployment one team's runaway sweep refused every other team's runs — a
 * self-inflicted DoS whose only signal was an HTTP 402. The fix scoped SPEND
 * to the owner but left the single `dailyUsd` as the figure it was measured
 * against — which quietly removed the only global ceiling. The owner id is a
 * caller-chosen header by default (`X-Sammy-User`), so rotating it minted a
 * fresh full cap each time; total exposure became cap × distinct owners,
 * unbounded. Keeping the per-team fairness WITHOUT losing the ceiling means
 * two numbers: the operator's "this is the most the workspace may spend" and,
 * optionally, "and this is the most any one owner may spend of it".
 *
 * A call with no `ownerId` (the boot banner, the global status surface)
 * evaluates only the global ceiling — there is no owner to hold to a
 * per-owner cap. The worker passes the delivery's owner, so a queued fire is
 * held to the same per-owner cap as a manual start.
 *
 * Module is server-only — it pulls in db.ts (native better-sqlite3).
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { RunStore } from './run-store';

export type BudgetConfig = {
  /** GLOBAL USD cap on workspace-wide spend for the current calendar day.
   *  null = no cap. */
  dailyUsd: number | null;
  /** GLOBAL USD cap on workspace-wide spend for the current calendar month.
   *  null = no cap. */
  monthlyUsd: number | null;
  /** USD cap on any ONE owner's spend for the current calendar day.
   *  null / absent = no per-owner cap. Optional so a caller that only knows
   *  the two global fields (the budget PUT route) still type-checks; a
   *  field left `undefined` on write keeps the file's current value. */
  perOwnerDailyUsd?: number | null;
  /** USD cap on any ONE owner's spend for the current calendar month. */
  perOwnerMonthlyUsd?: number | null;
};

export type BudgetStatus = {
  /** The GLOBAL ceiling and the unscoped spend it is measured against. */
  dailyLimit: number | null;
  monthlyLimit: number | null;
  dailyUsed: number;
  monthlyUsed: number;
  /** The per-owner cap and the requesting owner's own spend. `ownerDailyUsed`
   *  / `ownerMonthlyUsed` equal the global figures when the status was
   *  computed with no owner. */
  perOwnerDailyLimit: number | null;
  perOwnerMonthlyLimit: number | null;
  ownerDailyUsed: number;
  ownerMonthlyUsed: number;
  /** At or over 100% of ANY limit (global or per-owner) — new runs must be
   *  refused. */
  blocked: boolean;
  /** WHICH caps are at or over 100%, so a refusal can name the one that
   *  bit and the figures it was measured against. The refusal message used
   *  to print only the global figures and point at Settings, which was
   *  wrong on both counts when the PER-OWNER cap was the one breached.
   *  Empty when not blocked. */
  breached: BudgetCap[];
  /** At or over 80% of any limit — warn, but still allow runs. */
  warning: boolean;
};

/** The four caps `evaluateBudget` measures, named for `breached`. */
export type BudgetCap = 'daily' | 'monthly' | 'ownerDaily' | 'ownerMonthly';

/** Snapshot handed to the run-controller so an in-flight run can be
 *  halted the moment its accumulating cost would push total spend past
 *  a cap — not just gated at start time. The global fields are always
 *  present; the per-owner fields are set only when the gate was built for
 *  a specific owner. */
export type BudgetGate = {
  dailyLimitUsd: number | null;
  monthlyLimitUsd: number | null;
  daySpentBeforeUsd: number;
  monthSpentBeforeUsd: number;
  perOwnerDailyLimitUsd?: number | null;
  perOwnerMonthlyLimitUsd?: number | null;
  ownerDaySpentBeforeUsd?: number;
  ownerMonthSpentBeforeUsd?: number;
};

/** A positive finite number, or null. Rejects 0, NaN, negatives — all
 *  of which mean "no cap" rather than "cap of zero". */
function sanitizeLimit(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v;
}

/** The fully-populated shape every reader hands back (per-owner fields
 *  present, null when unset) so a consumer never has to distinguish
 *  "absent" from "no cap". */
type ResolvedBudgetConfig = Required<BudgetConfig>;

export async function readBudgetConfig(
  file: string,
): Promise<ResolvedBudgetConfig> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Record<
      string,
      unknown
    >;
    return {
      dailyUsd: sanitizeLimit(parsed.dailyUsd),
      monthlyUsd: sanitizeLimit(parsed.monthlyUsd),
      perOwnerDailyUsd: sanitizeLimit(parsed.perOwnerDailyUsd),
      perOwnerMonthlyUsd: sanitizeLimit(parsed.perOwnerMonthlyUsd),
    };
  } catch {
    // Missing / unreadable / malformed → no caps configured.
    return {
      dailyUsd: null,
      monthlyUsd: null,
      perOwnerDailyUsd: null,
      perOwnerMonthlyUsd: null,
    };
  }
}

export async function writeBudgetConfig(
  file: string,
  cfg: BudgetConfig,
): Promise<ResolvedBudgetConfig> {
  // A per-owner field the caller did not mention (`undefined`, as opposed
  // to an explicit `null`) keeps whatever the file already holds. The
  // budget PUT route only knows the two global fields; without this, every
  // save from the Settings page would silently wipe an operator's
  // file-configured per-owner caps.
  const current = await readBudgetConfig(file);
  const clean: ResolvedBudgetConfig = {
    dailyUsd: sanitizeLimit(cfg.dailyUsd),
    monthlyUsd: sanitizeLimit(cfg.monthlyUsd),
    perOwnerDailyUsd:
      cfg.perOwnerDailyUsd === undefined
        ? current.perOwnerDailyUsd
        : sanitizeLimit(cfg.perOwnerDailyUsd),
    perOwnerMonthlyUsd:
      cfg.perOwnerMonthlyUsd === undefined
        ? current.perOwnerMonthlyUsd
        : sanitizeLimit(cfg.perOwnerMonthlyUsd),
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  return clean;
}

type Spend = { todayUsd: number; monthUsd: number };

/** Spend ÷ cap, or 0 when there is no cap. */
function ratio(limit: number | null | undefined, used: number): number {
  return limit != null && limit > 0 ? used / limit : 0;
}

/** Pure: turn a config + spend snapshots into a UI-facing status.
 *
 *  `spend` is the UNSCOPED workspace total the global ceiling is measured
 *  against. `ownerSpend` is one owner's share, measured against the
 *  per-owner cap; omit it when there is no owner in play and the per-owner
 *  cap is simply not evaluated. */
export function evaluateBudget(
  cfg: BudgetConfig,
  spend: Spend,
  ownerSpend?: Spend,
): BudgetStatus {
  const dailyRatio = ratio(cfg.dailyUsd, spend.todayUsd);
  const monthlyRatio = ratio(cfg.monthlyUsd, spend.monthUsd);
  const ownerDailyRatio = ownerSpend
    ? ratio(cfg.perOwnerDailyUsd, ownerSpend.todayUsd)
    : 0;
  const ownerMonthlyRatio = ownerSpend
    ? ratio(cfg.perOwnerMonthlyUsd, ownerSpend.monthUsd)
    : 0;
  const ratios: Array<[BudgetCap, number]> = [
    ['daily', dailyRatio],
    ['monthly', monthlyRatio],
    ['ownerDaily', ownerDailyRatio],
    ['ownerMonthly', ownerMonthlyRatio],
  ];
  const breached = ratios.filter(([, r]) => r >= 1).map(([cap]) => cap);
  return {
    dailyLimit: cfg.dailyUsd,
    monthlyLimit: cfg.monthlyUsd,
    dailyUsed: spend.todayUsd,
    monthlyUsed: spend.monthUsd,
    perOwnerDailyLimit: cfg.perOwnerDailyUsd ?? null,
    perOwnerMonthlyLimit: cfg.perOwnerMonthlyUsd ?? null,
    ownerDailyUsed: (ownerSpend ?? spend).todayUsd,
    ownerMonthlyUsed: (ownerSpend ?? spend).monthUsd,
    blocked: breached.length > 0,
    breached,
    warning: ratios.some(([, r]) => r >= 0.8),
  };
}

/** Load the config + current spend, return both the human-facing
 *  status and the gate the run-controller uses for mid-run halting. */
export async function loadBudgetState(
  file: string,
  store: RunStore,
  /**
   * The owner whose per-owner cap to evaluate, in addition to the global
   * ceiling (which is always evaluated, against unscoped spend — see the
   * file header for why both). Omit it for the workspace-wide figure (the
   * boot banner, the global status surface); the per-owner cap is then not
   * evaluated, because there is no owner to hold to it.
   */
  ownerId?: string,
): Promise<{ status: BudgetStatus; gate: BudgetGate }> {
  const cfg = await readBudgetConfig(file);
  const spend = await store.costSummary();
  const ownerSpend =
    ownerId !== undefined ? await store.costSummary(ownerId) : undefined;
  const gate: BudgetGate = {
    dailyLimitUsd: cfg.dailyUsd,
    monthlyLimitUsd: cfg.monthlyUsd,
    daySpentBeforeUsd: spend.todayUsd,
    monthSpentBeforeUsd: spend.monthUsd,
  };
  if (ownerSpend) {
    gate.perOwnerDailyLimitUsd = cfg.perOwnerDailyUsd;
    gate.perOwnerMonthlyLimitUsd = cfg.perOwnerMonthlyUsd;
    gate.ownerDaySpentBeforeUsd = ownerSpend.todayUsd;
    gate.ownerMonthSpentBeforeUsd = ownerSpend.monthUsd;
  }
  return { status: evaluateBudget(cfg, spend, ownerSpend), gate };
}

/** Return a human-readable reason if `extraCostUsd` of new spend would
 *  breach a cap, else null. Used by the controller after each phase to
 *  decide whether to halt the run. Checks the global ceiling first, then
 *  the per-owner cap (when the gate carries one) — the run's own cost
 *  counts against both. */
export function checkGateBreach(
  gate: BudgetGate,
  extraCostUsd: number,
): string | null {
  if (
    gate.dailyLimitUsd != null &&
    gate.daySpentBeforeUsd + extraCostUsd > gate.dailyLimitUsd
  ) {
    const reached = gate.daySpentBeforeUsd + extraCostUsd;
    return `daily budget of $${gate.dailyLimitUsd.toFixed(2)} exceeded — spend reached $${reached.toFixed(2)}`;
  }
  if (
    gate.monthlyLimitUsd != null &&
    gate.monthSpentBeforeUsd + extraCostUsd > gate.monthlyLimitUsd
  ) {
    const reached = gate.monthSpentBeforeUsd + extraCostUsd;
    return `monthly budget of $${gate.monthlyLimitUsd.toFixed(2)} exceeded — spend reached $${reached.toFixed(2)}`;
  }
  if (
    gate.perOwnerDailyLimitUsd != null &&
    gate.ownerDaySpentBeforeUsd !== undefined &&
    gate.ownerDaySpentBeforeUsd + extraCostUsd > gate.perOwnerDailyLimitUsd
  ) {
    const reached = gate.ownerDaySpentBeforeUsd + extraCostUsd;
    return `per-owner daily budget of $${gate.perOwnerDailyLimitUsd.toFixed(2)} exceeded — this owner's spend reached $${reached.toFixed(2)}`;
  }
  if (
    gate.perOwnerMonthlyLimitUsd != null &&
    gate.ownerMonthSpentBeforeUsd !== undefined &&
    gate.ownerMonthSpentBeforeUsd + extraCostUsd > gate.perOwnerMonthlyLimitUsd
  ) {
    const reached = gate.ownerMonthSpentBeforeUsd + extraCostUsd;
    return `per-owner monthly budget of $${gate.perOwnerMonthlyLimitUsd.toFixed(2)} exceeded — this owner's spend reached $${reached.toFixed(2)}`;
  }
  return null;
}
