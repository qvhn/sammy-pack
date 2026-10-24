/**
 * Admission — the per-orchestration checks a trigger fire must pass before it
 * becomes a run, beyond the workspace budget and the concurrency gate:
 *
 *   - INTAKE PAUSE: an operator switch that stops an orchestration's triggers
 *     from starting runs without editing (or deleting) the orchestration. The
 *     state lives in `<root>/intake-pauses.json` so it survives a restart and
 *     the standalone worker (which shares the root) honors it too.
 *   - LIMITS: the root's `limits` block — runs per day, spend per day / month,
 *     scoped to THIS orchestration. The workspace budget caps everything at
 *     once; this caps one automation so a noisy intake can't spend the whole
 *     workspace's allowance.
 *
 * Every outcome here is "not now", never "never": a paused or capped fire is
 * HELD (re-queued without spending a retry attempt) until the condition can
 * have cleared, so nothing an operator paused is lost — except schedule-fired
 * ticks (cron / polling), which are refused instead. Holding them would replay
 * a backlog of stale ticks in a burst on resume, which no schedule wants.
 *
 * Pure decision + small file I/O; no run engine, so it is unit-testable and
 * shared verbatim by the dev server and the standalone worker.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { OrchestrationLimits } from '../types';

export { validateLimits } from '../intake-options';
import type { RunStore } from './run-store';

/** How often a paused orchestration's held deliveries re-check the switch.
 *  Held rows never count toward ingress backpressure (it counts only rows
 *  that are DUE), so this only bounds how quickly a resume is noticed when
 *  it did not go through the resume route (which releases them at once). */
export const PAUSE_RECHECK_MS = 60_000;

const warnedNoUsage = new Set<string>();

/** How long a workspace-budget refusal holds a delivery before re-checking. */
export const BUDGET_RECHECK_MS = 5 * 60_000;

export const INTAKE_PAUSES_FILE = 'intake-pauses.json';

/** Kinds fired by a schedule rather than by a sender: refused, not held. */
const SCHEDULE_KINDS = new Set(['cron', 'polling']);

export type IntakePause = {
  pausedAt: number;
  /** Who paused it (the caller's identity), for the audit trail. */
  by?: string;
  reason?: string;
};

export type AdmissionVerdict =
  | { action: 'admit' }
  | { action: 'hold'; until: number; reason: string }
  | { action: 'refuse'; reason: string };

/** Start of the local day / month containing `now` — the same calendar the
 *  workspace budget uses (`costSummary`), so the two caps agree on "today". */
export function calendarWindow(now: number): {
  dayStart: number;
  nextDayStart: number;
  monthStart: number;
  nextMonthStart: number;
} {
  const d = new Date(now);
  return {
    dayStart: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
    nextDayStart: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(),
    monthStart: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
    nextMonthStart: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(),
  };
}

/**
 * Decide whether one orchestration's limits admit another run now.
 * Unset limits admit. A limit of 0 is a deliberate "no runs" and holds.
 */
export async function checkLimits(
  store: Pick<RunStore, 'orchestrationUsage'>,
  orchestrationName: string,
  limits: OrchestrationLimits | undefined,
  now: number,
): Promise<AdmissionVerdict> {
  if (!limits) return { action: 'admit' };
  const { maxRunsPerDay, maxCostUsdPerDay, maxCostUsdPerMonth } = limits;
  if (
    maxRunsPerDay === undefined &&
    maxCostUsdPerDay === undefined &&
    maxCostUsdPerMonth === undefined
  ) {
    return { action: 'admit' };
  }
  if (!store.orchestrationUsage) {
    // A RunStore from before `limits` existed cannot count usage. Say so
    // (once per orchestration) rather than pretend the limit is enforced.
    if (!warnedNoUsage.has(orchestrationName)) {
      warnedNoUsage.add(orchestrationName);
      console.warn(
        `[admission] "${orchestrationName}" declares limits, but this run store has no ` +
          'orchestrationUsage() — the limits are NOT enforced',
      );
    }
    return { action: 'admit' };
  }
  const w = calendarWindow(now);
  const usage = await store.orchestrationUsage(orchestrationName, {
    dayStart: w.dayStart,
    monthStart: w.monthStart,
  });
  if (maxCostUsdPerMonth !== undefined && usage.monthUsd >= maxCostUsdPerMonth) {
    return {
      action: 'hold',
      until: w.nextMonthStart,
      reason:
        `limits.maxCostUsdPerMonth reached for "${orchestrationName}" — ` +
        `$${usage.monthUsd.toFixed(2)} of $${maxCostUsdPerMonth.toFixed(2)} this month`,
    };
  }
  if (maxCostUsdPerDay !== undefined && usage.todayUsd >= maxCostUsdPerDay) {
    return {
      action: 'hold',
      until: w.nextDayStart,
      reason:
        `limits.maxCostUsdPerDay reached for "${orchestrationName}" — ` +
        `$${usage.todayUsd.toFixed(2)} of $${maxCostUsdPerDay.toFixed(2)} today`,
    };
  }
  if (maxRunsPerDay !== undefined && usage.runsToday >= maxRunsPerDay) {
    return {
      action: 'hold',
      until: w.nextDayStart,
      reason:
        `limits.maxRunsPerDay reached for "${orchestrationName}" — ` +
        `${usage.runsToday} of ${maxRunsPerDay} runs today`,
    };
  }
  return { action: 'admit' };
}

/**
 * The intake-pause switch, persisted as a small JSON map in the workspace
 * root. Reads go to disk every time (it is a few hundred bytes, read once per
 * delivery) so a pause written by the dev server takes effect in a standalone
 * worker on its next claim without any signalling between the processes.
 */
export class IntakePauseStore {
  private readonly file: string;
  /** Serializes read-modify-write within this process. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.file = path.join(root, INTAKE_PAUSES_FILE);
  }

  async list(): Promise<Record<string, IntakePause>> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      return parsed as Record<string, IntakePause>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
      // FAIL CLOSED is wrong here and fail-open is silent, so say it loudly:
      // a corrupt file must not pause everything forever, nor quietly drop
      // the pauses an operator set. Treat it as empty and warn every read.
      console.warn(
        `[admission] ${this.file} is unreadable (${(err as Error).message}) — ` +
          'treating every orchestration as NOT paused until it is fixed',
      );
      return {};
    }
  }

  async get(orchestrationName: string): Promise<IntakePause | null> {
    const all = await this.list();
    return Object.prototype.hasOwnProperty.call(all, orchestrationName)
      ? all[orchestrationName]
      : null;
  }

  async pause(orchestrationName: string, info: Omit<IntakePause, 'pausedAt'>, now = Date.now()) {
    return this.mutate(all => {
      all[orchestrationName] = { pausedAt: now, ...info };
    });
  }

  /** Returns whether it was paused. */
  async resume(orchestrationName: string): Promise<boolean> {
    let was = false;
    await this.mutate(all => {
      was = Object.prototype.hasOwnProperty.call(all, orchestrationName);
      delete all[orchestrationName];
    });
    return was;
  }

  private mutate(fn: (all: Record<string, IntakePause>) => void): Promise<void> {
    const next = this.chain.then(async () => {
      const all = await this.list();
      fn(all);
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
      await fs.rename(tmp, this.file);
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

/**
 * The whole per-orchestration admission decision for one trigger fire.
 * Order: pause first (an operator's explicit stop outranks everything), then
 * limits. Manual starts (POST /api/runs/start) don't come through here: an
 * operator explicitly starting a run is not intake, and the workspace budget
 * still bounds them.
 */
export async function admitDelivery(opts: {
  store: Pick<RunStore, 'orchestrationUsage'>;
  pauses: IntakePauseStore;
  orchestrationName: string;
  limits: OrchestrationLimits | undefined;
  kind: string;
  now: number;
}): Promise<AdmissionVerdict> {
  const paused = await opts.pauses.get(opts.orchestrationName);
  if (paused) {
    const why =
      `intake for "${opts.orchestrationName}" is paused` +
      (paused.by ? ` by ${paused.by}` : '') +
      (paused.reason ? ` (${paused.reason})` : '');
    if (SCHEDULE_KINDS.has(opts.kind)) {
      return { action: 'refuse', reason: `${why} — scheduled tick skipped` };
    }
    return { action: 'hold', until: opts.now + PAUSE_RECHECK_MS, reason: why };
  }
  const limited = await checkLimits(opts.store, opts.orchestrationName, opts.limits, opts.now);
  if (limited.action === 'hold' && isScheduleKind(opts.kind)) {
    return { action: 'refuse', reason: `${limited.reason} — scheduled tick skipped` };
  }
  return limited;
}

/** Schedule-fired kinds are REFUSED rather than held by every admission
 *  check: a held tick replays later as a stale burst — holding an hourly cron
 *  until midnight grows a backlog every day — and the next tick does the
 *  work anyway. */
export function isScheduleKind(kind: string): boolean {
  return SCHEDULE_KINDS.has(kind);
}
