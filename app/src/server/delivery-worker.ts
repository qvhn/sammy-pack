/**
 * DeliveryWorker — drains the durable trigger-delivery queue (P1).
 *
 * Trigger fires no longer create runs inline. `deliver()` records a
 * `pending` delivery and returns; this worker claims pending deliveries
 * (atomically, via the store's claimNextDelivery) and asks `runDelivery`
 * to create the run. The boundary is now durable + recoverable: a worker
 * that dies mid-flight leaves a `claimed` row that reclaimStaleDeliveries
 * requeues, and failures retry with backoff (P2) until exhausted →
 * `failed` (dead-letter).
 *
 * Backend-agnostic: claim safety is the store's job (Postgres FOR UPDATE
 * SKIP LOCKED; SQLite synchronous transaction), so several worker loops —
 * or several processes (P6) — can share one queue without double-claiming.
 *
 * The clock is injectable (`now`) and the core step (`processOne`) and
 * `drain` are awaitable, so tests run deterministically without timers.
 */

import type { DeliveryRecord, RunStore } from './run-store';

export type RunDeliveryResult =
  | { ok: true; runId: string }
  /** The fire was durably PARKED behind a busy concurrency group and will
   *  run when the group frees. Distinct from a refusal: recording it as
   *  `rejected` put a fire that was going to run into the dead-letter view,
   *  so an operator would replay it and get TWO runs — one from the queue
   *  drain and one from the replay. */
  | { ok: false; deferred: true; detail: string }
  /** Not admissible NOW, but expected to become so on its own (intake
   *  paused, a daily cap spent, the budget exhausted): requeue for `until`
   *  WITHOUT consuming an attempt. Never dead-letters. */
  | { ok: false; hold: true; until: number; detail: string }
  | { ok: false; error: string; retryable?: boolean };

/** Turn a claimed delivery into a run. Return `retryable: true` for
 *  transient failures (the worker will back off and retry); `false` (the
 *  default) is a policy refusal → terminal `rejected`; `deferred` means
 *  parked and pending elsewhere. */
export type RunDeliveryFn = (d: DeliveryRecord) => Promise<RunDeliveryResult>;

export type DeliveryWorkerOpts = {
  store: RunStore;
  runDelivery: RunDeliveryFn;
  /** Concurrent claim loops. Default 4. */
  concurrency?: number;
  /** Total tries before a retryable delivery is dead-lettered. Default 5. */
  maxAttempts?: number;
  /** Idle poll cadence when the queue is empty. Default 500ms. */
  pollIntervalMs?: number;
  /** A `claimed` delivery older than this is presumed orphaned (its worker
   *  died) and requeued. Default 60s. */
  reclaimAfterMs?: number;
  /** How often to sweep for stale claims. Default 30s. */
  reclaimEveryMs?: number;
  /** Per-orchestration in-flight cap (P2 fairness). Unset = no cap. */
  maxInFlightPerOrch?: number;
  /** Retry backoff by attempt number (1-based). Default capped exp. */
  backoffMs?: (attempt: number) => number;
  /** Injectable clock (tests). Default Date.now. */
  now?: () => number;
  log?: (msg: string) => void;
};

const defaultBackoff = (attempt: number): number =>
  Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1));

/** `setTimeout`/`setInterval` type as DOM `number` under this tsconfig, so
 *  `.unref()` (Node-only — keeps timers from holding the process open)
 *  isn't on the type. Call it defensively. */
function unrefTimer(t: ReturnType<typeof setTimeout>): void {
  (t as unknown as { unref?: () => void }).unref?.();
}

export class DeliveryWorker {
  private readonly store: RunStore;
  private readonly runDelivery: RunDeliveryFn;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly reclaimAfterMs: number;
  private readonly reclaimEveryMs: number;
  private readonly maxInFlightPerOrch: number | undefined;
  private readonly backoffMs: (attempt: number) => number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  private running = false;
  private kicking = false;
  private loops: Array<Promise<void>> = [];
  private reclaimTimer: ReturnType<typeof setInterval> | null = null;
  /** Pending sleeps, each mapped to its OWN resolver.
   *
   *  The resolver has to be reachable from `stop()`. Keeping only the timer
   *  handle (as a Set) looks sufficient and is not: `resolve()` ran solely
   *  from inside the timer callback, so clearing the timer stranded the
   *  promise forever and `stop()` hung on it. */
  private readonly pendingSleeps = new Map<ReturnType<typeof setTimeout>, () => void>();

  /** Set when `kick()` is called during an in-flight drain. */
  private kickAgain = false;

  constructor(opts: DeliveryWorkerOpts) {
    this.store = opts.store;
    this.runDelivery = opts.runDelivery;
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
    this.pollIntervalMs = Math.max(1, opts.pollIntervalMs ?? 500);
    this.reclaimAfterMs = Math.max(1000, opts.reclaimAfterMs ?? 60_000);
    this.reclaimEveryMs = Math.max(1000, opts.reclaimEveryMs ?? 30_000);
    this.maxInFlightPerOrch =
      opts.maxInFlightPerOrch && opts.maxInFlightPerOrch > 0
        ? opts.maxInFlightPerOrch
        : undefined;
    this.backoffMs = opts.backoffMs ?? defaultBackoff;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** Claim one delivery and settle it (complete / reject / retry / fail).
   *  Returns the delivery processed, or null if nothing was claimable. */
  async processOne(): Promise<DeliveryRecord | null> {
    const d = await this.store.claimNextDelivery(this.now(), {
      maxInFlightPerOrch: this.maxInFlightPerOrch,
    });
    if (!d) return null;
    try {
      const res = await this.runDelivery(d);
      if (!res.ok && 'deferred' in res) {
        // Parked, not refused — terminal for the DELIVERY (its job of
        // durably placing the fire is done) but not a dead letter.
        this.noteFence(
          d,
          await this.store.deferDelivery(d.id, res.detail, this.now(), d.claimToken),
          'deferred behind a busy concurrency group',
        );
        return d;
      }
      if (!res.ok && 'hold' in res) {
        // A store without holdDelivery (written before holds existed) gets a
        // plain retry at `until` — the fire still waits, it just spends an
        // attempt doing so.
        const won = this.store.holdDelivery
          ? await this.store.holdDelivery(d.id, {
              until: res.until,
              detail: res.detail,
              claimToken: d.claimToken,
            })
          : await this.store.failDelivery(d.id, {
              error: res.detail,
              now: this.now(),
              retryAt: res.until,
              claimToken: d.claimToken,
            });
        this.noteFence(d, won, 'held');
        if (won) {
          this.log(
            `delivery ${d.id} held until ${new Date(res.until).toISOString()}: ${res.detail}`,
          );
        }
        return d;
      }
      if (res.ok) {
        this.noteFence(
          d,
          await this.store.completeDelivery(d.id, res.runId, this.now(), d.claimToken),
          `completed as run ${res.runId}`,
        );
      } else if (res.retryable) {
        await this.retryOrFail(d, res.error);
      } else {
        this.noteFence(
          d,
          await this.store.rejectDelivery(d.id, res.error, this.now(), d.claimToken),
          'rejected',
        );
      }
    } catch (err) {
      // The handler itself threw — treat as a transient failure.
      await this.retryOrFail(d, (err as Error)?.message ?? String(err));
    }
    return d;
  }

  /** Report a LOST CLAIM loudly.
   *
   *  A false return from a fenced settle means this worker stalled past the
   *  reclaim window, the delivery was handed to someone else, and whatever
   *  this worker just did is now an orphan. Silence here is how one accepted
   *  fire quietly became two live runs: the stale owner's write used to land
   *  on top of the new owner's. There is nothing to repair from here — the
   *  new owner is authoritative — so the correct action is to say so, which
   *  is also the only signal that reclaimAfterMs is set too low (or that a
   *  handler is hanging). */
  private noteFence(d: DeliveryRecord, won: boolean, what: string): void {
    if (won) return;
    this.log(
      `delivery ${d.id} LOST ITS CLAIM (token ${d.claimToken}) before being ` +
        `${what} — it was reclaimed and is owned by another worker now, so ` +
        'this attempt is abandoned. If this recurs, the handler is slower ' +
        'than reclaimAfterMs.',
    );
  }

  /** `d.attempts` already counts this claim. Retry with backoff while tries
   *  remain; otherwise dead-letter. */
  private async retryOrFail(d: DeliveryRecord, error: string): Promise<void> {
    if (d.attempts < this.maxAttempts) {
      const retryAt = this.now() + this.backoffMs(d.attempts);
      const won = await this.store.failDelivery(d.id, {
        error,
        now: this.now(),
        retryAt,
        claimToken: d.claimToken,
      });
      this.noteFence(d, won, 'requeued for retry');
      if (won) {
        this.log(
          `delivery ${d.id} attempt ${d.attempts}/${this.maxAttempts} failed: ${error} — retry in ${retryAt - this.now()}ms`,
        );
      }
    } else {
      const won = await this.store.failDelivery(d.id, {
        error,
        now: this.now(),
        claimToken: d.claimToken,
      });
      this.noteFence(d, won, 'dead-lettered');
      if (won) {
        this.log(
          `delivery ${d.id} dead-lettered after ${d.attempts} attempts: ${error}`,
        );
      }
    }
  }

  /** Process claimable deliveries sequentially until the queue is empty.
   *  Bounded so a runaway producer can't spin a single drain forever. */
  async drain(): Promise<number> {
    let n = 0;
    while (n < 10_000) {
      const d = await this.processOne();
      if (!d) break;
      n += 1;
    }
    return n;
  }

  /** Start the background loops + the stale-claim sweeper. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (let i = 0; i < this.concurrency; i += 1) this.spawnLoop();
    this.reclaimTimer = setInterval(() => {
      void this.store
        .reclaimStaleDeliveries(this.reclaimAfterMs, this.now())
        .then(r => {
          if (r.count > 0) {
            this.log(`reclaimed ${r.count} stale delivery(ies): ${r.ids.join(', ')}`);
          }
        })
        .catch(e => this.reportLoopError('reclaim sweep failed', e));
    }, this.reclaimEveryMs);
    unrefTimer(this.reclaimTimer);
  }

  /** True when an error means "the store is gone", i.e. we are being torn
   *  down. better-sqlite3 says "The database connection is not open"; pg says
   *  the pool/client has ended. */
  private static isStoreClosed(e: unknown): boolean {
    const m = (e as Error)?.message ?? String(e);
    return (
      /database connection is not open/i.test(m) ||
      /database is closed/i.test(m) ||
      /Cannot use a pool after calling end/i.test(m) ||
      /Client was closed/i.test(m)
    );
  }

  /** Report a loop error — unless the store has closed under us, in which
   *  case this is shutdown, not a fault.
   *
   *  The mount's close hook calls `stop()` WITHOUT awaiting it and then
   *  closes the store, so an in-flight drain reliably meets a dead
   *  connection. On a fast machine the window is too small to notice; on a
   *  slow CI runner (~4.7x slower here) it is hit every time, and the
   *  resulting log lands after the test that owned the mount has finished —
   *  which jest reports as "Cannot log after tests are done" and turns into
   *  a non-zero exit with every test still passing. Staying quiet on a
   *  closed store fixes the exit code AND is the honest behaviour: there is
   *  nothing to report about work that was deliberately torn down. */
  private reportLoopError(prefix: string, e: unknown): void {
    if (DeliveryWorker.isStoreClosed(e)) {
      // Shutting down: make sure no further iteration tries the dead store.
      this.running = false;
      return;
    }
    this.log(`${prefix}: ${e}`);
  }

  private spawnLoop(): void {
    const loop = (async () => {
      while (this.running) {
        let processed: DeliveryRecord | null = null;
        try {
          processed = await this.processOne();
        } catch (e) {
          this.reportLoopError('worker loop error', e);
        }
        if (!processed && this.running) await this.sleep(this.pollIntervalMs);
      }
    })();
    this.loops.push(loop);
  }

  /** Low-latency nudge: when something is enqueued, drain now rather than
   *  waiting for the next idle poll. Non-blocking; concurrent kicks fold
   *  into one drain. No-op when stopped. */
  kick(): void {
    if (!this.running) return;
    if (this.kicking) {
      // A nudge arriving mid-drain is NOT redundant: the in-flight drain may
      // already have observed an empty queue, so folding this one into it
      // dropped it and the new delivery waited for the 500ms poll instead.
      // Remember it and drain once more when the current pass ends.
      this.kickAgain = true;
      return;
    }
    this.kicking = true;
    void this.drainLoop();
  }

  /** Drain, then drain again if a nudge arrived while we were draining. */
  private async drainLoop(): Promise<void> {
    try {
      for (;;) {
        this.kickAgain = false;
        await this.drain().catch(e => this.reportLoopError('kick drain error', e));
        if (!this.kickAgain || !this.running) return;
      }
    } finally {
      this.kicking = false;
    }
  }

  /** Stop loops + sweeper. Awaits in-flight loop iterations. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.reclaimTimer) {
      clearInterval(this.reclaimTimer);
      this.reclaimTimer = null;
    }
    // Cancel each pending sleep AND settle its promise. Clearing the timer
    // alone leaves the loop awaiting a promise nothing will ever resolve, so
    // the `allSettled` below never returns — which is why SIGTERM used to
    // hang the worker (an idle worker is nearly always inside a sleep).
    for (const [t, wake] of this.pendingSleeps) {
      clearTimeout(t);
      wake();
    }
    this.pendingSleeps.clear();
    await Promise.allSettled(this.loops);
    this.loops = [];
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const t = setTimeout(() => {
        this.pendingSleeps.delete(t);
        resolve();
      }, ms);
      unrefTimer(t);
      this.pendingSleeps.set(t, resolve);
    });
  }
}
