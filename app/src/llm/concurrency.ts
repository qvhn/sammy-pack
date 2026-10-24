/**
 * Global agent-dispatch concurrency limiter.
 *
 * The resource that actually overloads the machine is **concurrent
 * `@anthropic-ai/claude-agent-sdk` subprocesses** — one per in-flight leaf
 * agent call. A cap on top-level *runs* doesn't bound that: a single phase
 * can fan out (`parallel` runs every branch at once; `map` fans over an
 * array), and N runs × M subagents each = N·M subprocesses. So the limiter
 * lives at the **leaf-dispatch chokepoint** (the streamFn call in
 * `runAgentPhase`), shared process-wide, where it bounds the real resource
 * no matter how many runs or how wide the fan-out.
 *
 * Deadlock-freedom: ONLY leaf dispatches acquire a slot, held for exactly
 * one SDK call then released in a `finally`. Composite nodes (`parallel`,
 * `phases`, `route`, `loop`, `converge`, `subflow`, `map`) never hold a
 * slot — they only orchestrate and await children. Since no slot-holder
 * ever waits on another slot, the wait-for graph has no cycle: nesting
 * `parallel`-in-`map`-in-`subflow` can never deadlock. Excess dispatches
 * queue FIFO and acquire as slots free.
 */

/** Released exactly once; extra calls are no-ops (safe in a `finally`). */
export type Release = () => void;

/** Caller-supplied identity for a queued dispatch, carried alongside the
 *  waiter so the queue is introspectable (which run / phase is blocked)
 *  and reorderable (operators can promote a waiting job by its id). All
 *  optional — bare `acquire()` still works and just shows up anonymously. */
export type WaiterMeta = {
  /** Owning run id, when the dispatch belongs to a server-owned run. */
  runId?: string;
  /** The orchestration this dispatch is part of (display only). */
  orchestrationName?: string;
  /** Leaf phase name being dispatched. */
  phaseName?: string;
};

/** A point-in-time view of one queued (still-blocked) dispatch. */
export type QueuedWaiter = WaiterMeta & {
  /** Stable per-waiter id (assigned at enqueue). The reorder API addresses
   *  waiters by this — array indices shift as slots drain, ids don't. */
  id: string;
  /** 0-based position in the grant order (0 = next to get a slot). */
  position: number;
  /** Epoch ms the dispatch began waiting — drives the "waited Ns" display. */
  enqueuedAt: number;
};

type InternalWaiter = WaiterMeta & {
  id: string;
  enqueuedAt: number;
  resolve: () => void;
};

let waiterSeq = 0;

export class Semaphore {
  private max: number;
  private active = 0;
  /** FIFO waiters — each resolves when a slot is granted to it. Ordered:
   *  index 0 is granted next. Reorderable via `moveWaiter` / `promoteWaiter`
   *  without ever disturbing in-flight (`active`) work. */
  private readonly waiters: InternalWaiter[] = [];

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max));
  }

  get limit(): number {
    return this.max;
  }
  /** Slots currently held (agents actively streaming). */
  get inUse(): number {
    return this.active;
  }
  /** Dispatches blocked waiting for a slot. */
  get waiting(): number {
    return this.waiters.length;
  }

  /** Resize the pool at runtime. Growing wakes queued waiters immediately;
   *  shrinking lets the surplus drain as in-flight calls finish (never
   *  interrupts a running agent). */
  setLimit(next: number): void {
    this.max = Math.max(1, Math.floor(next));
    this.drain();
  }

  /** Acquire a slot, returning a release fn. Resolves immediately if a slot
   *  is free, otherwise queues FIFO and resolves when one frees. `meta`
   *  (optional) is recorded on the waiter so the queue can be inspected and
   *  reordered while it's blocked. */
  async acquire(meta?: WaiterMeta): Promise<Release> {
    if (this.active < this.max) {
      this.active += 1;
      return this.makeRelease();
    }
    await new Promise<void>(resolve => {
      this.waiters.push({
        id: `w-${++waiterSeq}`,
        enqueuedAt: Date.now(),
        resolve,
        runId: meta?.runId,
        orchestrationName: meta?.orchestrationName,
        phaseName: meta?.phaseName,
      });
    });
    // Granted by drain(), which already incremented `active` on our behalf.
    return this.makeRelease();
  }

  /** A snapshot of the queued (still-blocked) dispatches in grant order. */
  snapshot(): QueuedWaiter[] {
    return this.waiters.map((w, i) => ({
      id: w.id,
      position: i,
      enqueuedAt: w.enqueuedAt,
      runId: w.runId,
      orchestrationName: w.orchestrationName,
      phaseName: w.phaseName,
    }));
  }

  /** Move the waiter with `id` to absolute 0-based `toIndex` (clamped),
   *  preserving every other waiter's relative order. Safe at any time:
   *  drain() always grants from the front, so reordering only changes which
   *  blocked waiter is served next — it never touches in-flight work, never
   *  double-grants, and never drops a waiter. Returns true if found+moved.
   *  No drain needed (a reorder frees no slot). */
  moveWaiter(id: string, toIndex: number): boolean {
    const from = this.waiters.findIndex(w => w.id === id);
    if (from === -1) return false;
    const clamped = Math.max(0, Math.min(toIndex, this.waiters.length - 1));
    if (from === clamped) return true;
    const [w] = this.waiters.splice(from, 1);
    this.waiters.splice(clamped, 0, w);
    return true;
  }

  /** Convenience: move `id` one place toward the front (sooner) or back
   *  (later). Returns true if the waiter exists. */
  bumpWaiter(id: string, dir: 'up' | 'down'): boolean {
    const from = this.waiters.findIndex(w => w.id === id);
    if (from === -1) return false;
    return this.moveWaiter(id, dir === 'up' ? from - 1 : from + 1);
  }

  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  /** Hand free slots to queued waiters, front first. */
  private drain(): void {
    while (this.active < this.max && this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      this.active += 1;
      w.resolve();
    }
  }
}

/** CPU-derived default — conservative so a fan-out can't melt a laptop, but
 *  raisable. `navigator.hardwareConcurrency` is available in browsers and in
 *  Node ≥ 21, so we avoid a node-only `os` import (executor.ts is bundled for
 *  the browser too). */
function defaultMaxConcurrentAgents(): number {
  const env = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env?.SAMMY_MAX_CONCURRENT_AGENTS;
  const fromEnv = Number(env);
  if (Number.isFinite(fromEnv) && fromEnv >= 1) return Math.floor(fromEnv);
  const cores = Number(
    (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
      ?.hardwareConcurrency,
  );
  const safeCores = Number.isFinite(cores) && cores > 0 ? cores : 4;
  // max(2, min(6, cores - 2)): leave headroom for the OS + the node host.
  return Math.max(2, Math.min(6, safeCores - 2));
}

/** Process-wide singleton every leaf agent dispatch funnels through. */
export const agentSlots = new Semaphore(defaultMaxConcurrentAgents());

/** Snapshot for observability (Settings UI / a status endpoint). */
export function agentSlotStats(): {
  limit: number;
  inUse: number;
  waiting: number;
} {
  return {
    limit: agentSlots.limit,
    inUse: agentSlots.inUse,
    waiting: agentSlots.waiting,
  };
}

/** The currently-queued (blocked) agent dispatches, in grant order — for
 *  the Queue view + the reorder API. Pairs with agentSlotStats() (the
 *  scalar counts) to fully describe the pool. */
export function agentQueueSnapshot(): QueuedWaiter[] {
  return agentSlots.snapshot();
}
