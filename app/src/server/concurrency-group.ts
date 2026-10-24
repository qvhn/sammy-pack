/**
 * Concurrency groups — mutual exclusion for runs that share an external
 * resource.
 *
 * PROBLEM: several triggers (cron, webhook, manual) can each start a run, and
 * two of those runs may contend for ONE shared external resource — a single
 * staging environment, a physical device, a rate-limited account. Nothing
 * stops two such runs from overlapping and corrupting each other.
 *
 * MODEL: an orchestration declares, at its root, `concurrency: { group,
 * policy? }`. `group` is an OPAQUE string — this module never interprets what
 * it stands for; two orchestrations naming the same group are simply declared
 * mutually exclusive. Runs in a group never run concurrently.
 *
 * This module is the framework-agnostic core of that feature:
 *   - `concurrencyOf(node)`      — read the root's group/policy (top-level only).
 *   - `decideConcurrency(...)`   — the PURE policy decision given the active
 *                                  runs in the group; unit-testable with a fake
 *                                  store, no run-creation side effects.
 *   - `GroupLock`                — an in-process per-group async mutex so the
 *                                  check-and-create is serialized within one
 *                                  process (two near-simultaneous same-process
 *                                  fires can't both pass the "no active" check).
 *
 * The wiring that actually creates / cancels runs lives in sammy-pack-api.ts;
 * this module deliberately holds no reference to the run-controller so it stays
 * pure and testable.
 *
 * CROSS-PROCESS EXCLUSION is a documented follow-up: the `GroupLock` is
 * in-memory, so two SEPARATE server processes (or the standalone worker)
 * sharing one store could still both pass the gate at the same instant. A
 * durable guard (a transactional "claim the group" row, or a Postgres advisory
 * lock keyed by the group) would close that — but for the single dev-server /
 * single-worker deployments this targets, the in-process lock is sufficient and
 * keeps the hot path allocation-free.
 */

import { createHash } from 'node:crypto';
import { interpolate } from '../llm/interpolate';
import type {
  ConcurrencyPolicy,
  Node,
  OrchestrationConcurrency,
} from '../types';
import type { PendingFire, RunHeader } from './run-store';

/** Default policy when `concurrency.group` is set but `policy` is omitted. */
export const DEFAULT_CONCURRENCY_POLICY: ConcurrencyPolicy = 'queue';

/**
 * Read a node's concurrency declaration. Top-level only: `concurrency` is only
 * honored on the orchestration ROOT, mirroring `defaults` / `autoApproveLocks`
 * — a value on a child node is meaningless and ignored by callers (which only
 * ever pass the root). Returns the normalized `{ group, policy }` (policy
 * defaulted) or null when there is no group.
 */
export function concurrencyOf(
  node: Pick<Node, 'concurrency'>,
): Required<OrchestrationConcurrency> | null {
  const c = node.concurrency;
  const group = c?.group;
  if (typeof group !== 'string' || group.trim() === '') return null;
  return { group, policy: c?.policy ?? DEFAULT_CONCURRENCY_POLICY };
}

/** How a cron trigger handles its own previous run still being in flight.
 *  Default 'skip'. */
export type CronOverlap = 'skip' | 'queue' | 'allow';

export const DEFAULT_CRON_OVERLAP: CronOverlap = 'skip';

/**
 * The group a fire is actually gated on — the root's explicit declaration if
 * there is one, otherwise an IMPLICIT per-orchestration group for cron fires.
 *
 * WHY THE IMPLICIT GROUP: a cron trigger set `noOverlap: true` on the
 * node-cron task, and the surrounding comment claimed that "stops a slow tick
 * from stacking onto its own prior run". It does not. node-cron suppresses a
 * tick only while the previous CALLBACK promise is pending, and that callback
 * just inserts a delivery row and returns in milliseconds — by the next tick
 * it is long resolved. The run itself is created later by the worker and is
 * fire-and-forget. So a `* * * * *` cron on a ten-minute orchestration
 * accumulated ~10 concurrent runs, each spawning agent subprocesses, and
 * nothing capped it: SAMMY_MAX_QUEUE_DEPTH counts only *pending* deliveries,
 * which drain instantly.
 *
 * Overlapping runs of one scheduled job is almost never what anyone wants, so
 * the default is `skip` — the previous run keeps going and this tick is
 * dropped. `queue` serializes instead (bounded work, but a slow run builds a
 * backlog), and `allow` restores the old unguarded behaviour explicitly.
 *
 * An explicit root `concurrency` block always wins: explicit beats implicit.
 */
/** The declared overlap handling, or null when the node has no cron trigger
 *  at all (so callers never invent a cron group for, say, a webhook-only
 *  orchestration). */
export function cronOverlapOf(node: Pick<Node, 'triggers'>): CronOverlap | null {
  const cron = node.triggers?.find(t => t.kind === 'cron');
  if (!cron) return null;
  const declared = (cron as { overlap?: unknown }).overlap;
  return declared === 'skip' || declared === 'queue' || declared === 'allow'
    ? declared
    : DEFAULT_CRON_OVERLAP;
}

/** True when a declared group is a TEMPLATE (`"intake:${input.fingerprint}"`)
 *  rather than a literal — its real group is only known per fire. */
export function isGroupTemplate(group: string): boolean {
  return group.includes('${');
}

/** Resolved groups longer than this are hashed, so an input field that holds a
 *  whole document can't become a multi-KB index key. */
export const MAX_RESOLVED_GROUP_CHARS = 200;

/**
 * Resolve a templated group against the fire's initial input.
 *
 * `${input}` is the raw input; `${input.a.b}` reads a field of the input parsed
 * as JSON. This is what makes "one active run PER KEY" expressible — e.g. one
 * triage run per error fingerprint — instead of one per orchestration.
 *
 * FAILS CLOSED. An unresolved reference stays literal, so every fire missing
 * the field lands in the SAME group (`intake:${input.fingerprint}`) and is
 * serialized rather than silently escaping the exclusion. `onUnresolved` lets
 * the caller say so.
 *
 * The payload chooses only the part AFTER the author's literal prefix. A
 * template with no literal prefix (`"${input.repo}"`) would let an inbound
 * event name ANY group — join another orchestration's `prod-deploy` group
 * and, under `cancel-existing`, cancel its runs — so such a template is
 * namespaced to its own orchestration (`tmpl:<orchestration>:<value>`). And
 * a resolved value can't impersonate a framework group: a result starting
 * with the reserved `sammy:` prefix when the template didn't is re-prefixed.
 */
export function resolveConcurrencyGroup(
  group: string,
  initialInput: string | null | undefined,
  onUnresolved?: (ref: string) => void,
  orchestrationName?: string,
): string {
  if (!isGroupTemplate(group)) return group;
  let resolved = interpolate(group, { input: initialInput ?? '' }, onUnresolved);
  if (group.startsWith('${')) {
    resolved = `tmpl:${orchestrationName ?? '?'}:${resolved}`;
  } else if (resolved.startsWith('sammy:') && !group.startsWith('sammy:')) {
    resolved = `u:${resolved}`;
  }
  if (resolved.length > MAX_RESOLVED_GROUP_CHARS) {
    const digest = createHash('sha256').update(resolved).digest('hex').slice(0, 32);
    resolved = `${resolved.slice(0, 64)}…sha256:${digest}`;
  }
  return resolved;
}

export function effectiveConcurrency(
  node: Pick<Node, 'name' | 'concurrency' | 'triggers'>,
  triggerKind: string,
  /** The fire's initial input — resolves a templated `group`. Omit it to get
   *  the DECLARED (possibly templated) group, e.g. for visibility. */
  initialInput?: string | null,
  onUnresolved?: (ref: string) => void,
): Required<OrchestrationConcurrency> | null {
  const explicit = concurrencyOf(node);
  if (explicit) {
    return initialInput === undefined
      ? explicit
      : {
          ...explicit,
          group: resolveConcurrencyGroup(explicit.group, initialInput, onUnresolved, node.name),
        };
  }
  if (triggerKind !== 'cron') return null;
  const overlap = cronOverlapOf(node);
  if (overlap === null || overlap === 'allow') return null;
  // Namespaced so it can never collide with an author-chosen group.
  return { group: `sammy:cron:${node.name}`, policy: overlap };
}

/**
 * The start-gate's decision for a fire, given the active runs already in its
 * group. PURE — no side effects, no run creation; the caller performs the
 * action the decision names. This is the unit-testable seam (drive it with a
 * fake store / a hand-built header list) so the skip/queue/cancel-existing
 * branching is verified without standing up the whole start path.
 *
 *   - no active runs           → `{ action: 'start' }` (create the run).
 *   - active + policy 'skip'   → `{ action: 'skip', blockingId }`.
 *   - active + policy 'queue'  → `{ action: 'queue', blockingId }` (park it).
 *   - active + 'cancel-existing' → `{ action: 'cancel-existing', cancelIds }`
 *                                  (cancel each, then create).
 *
 * `blockingId` is the oldest active run (the runs are passed started-at ASC),
 * surfaced only for logging.
 */
export type ConcurrencyDecision =
  | { action: 'start' }
  | { action: 'skip'; blockingId: string }
  | { action: 'queue'; blockingId: string }
  | { action: 'cancel-existing'; cancelIds: string[] };

export function decideConcurrency(
  policy: ConcurrencyPolicy,
  activeInGroup: ReadonlyArray<Pick<RunHeader, 'id'>>,
): ConcurrencyDecision {
  if (activeInGroup.length === 0) return { action: 'start' };
  const ids = activeInGroup.map(r => r.id);
  switch (policy) {
    case 'skip':
      return { action: 'skip', blockingId: ids[0] };
    case 'cancel-existing':
      return { action: 'cancel-existing', cancelIds: ids };
    case 'queue':
    default:
      return { action: 'queue', blockingId: ids[0] };
  }
}

/** The fields a parked fire needs — re-exported for the API wrapper's clarity. */
export type { PendingFire };

/**
 * In-process per-group async mutex. `run(group, fn)` serializes `fn` against
 * every other `run` call for the SAME group: each group keeps a promise "tail",
 * and a new call chains onto it, so only one critical section per group is in
 * flight at a time. Different groups never block each other.
 *
 * This is what makes the start-gate's check-and-create atomic within a process:
 * two near-simultaneous fires for the same group can't both observe "no active
 * run" and both create — the second waits for the first's create to land (and
 * its row to become visible to `findActiveRunsInGroup`) before it checks.
 *
 * The tail is cleared once it drains so the map doesn't grow unbounded across
 * many distinct groups over a long-lived process.
 *
 * NOT RE-ENTRANT, AND BOUNDED. A critical section that (transitively) calls
 * `run` for the same group waits on itself: the inner call chains behind the
 * outer one, which cannot finish until the inner one returns. Nothing in a
 * promise chain can detect that, so the lock cannot refuse it — but it can
 * refuse to wait forever. `acquireTimeoutMs` (default 60s, far above any
 * legitimate section, which is a check plus a row insert) turns a hang into
 * a rejection that NAMES the group, so the caller's fail-open path runs and
 * the operator sees a log line instead of a silently bricked group. The
 * cancel-existing start-gate was exactly this shape once (it drained a
 * parked fire, which re-entered the gate for the same group) and every
 * later fire for that group hung for the life of the process.
 */
export class GroupLock {
  private tails = new Map<string, Promise<void>>();
  private readonly acquireTimeoutMs: number;

  constructor(opts?: { acquireTimeoutMs?: number }) {
    this.acquireTimeoutMs = Math.max(1, opts?.acquireTimeoutMs ?? 60_000);
  }

  async run<T>(group: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(group) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => {
      release = resolve;
    });
    // Chain THIS section after whatever was already queued for the group.
    // The chained promise is kept in a local because it is what the map
    // holds: the `=== tail` cleanups below compare against it, and comparing
    // against `next` (a different promise) could never match, so no entry
    // was ever deleted and the map grew by one per distinct group forever.
    const tail = prev.then(() => next);
    this.tails.set(group, tail);
    // Wait for the prior holder to finish (swallow its rejection — each caller
    // owns its own errors; a prior failure must not reject this waiter) — but
    // only for so long.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const acquired = await Promise.race([
      prev.catch(() => {}).then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), this.acquireTimeoutMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (!acquired) {
      // Give up OUR turn without breaking the chain: our slot resolves only
      // when the prior holder finally finishes, so later waiters stay
      // serialized behind the real holder rather than running alongside it.
      void prev.catch(() => {}).then(() => {
        release();
        if (this.tails.get(group) === tail) this.tails.delete(group);
      });
      throw new Error(
        `group lock for "${group}" not acquired within ${this.acquireTimeoutMs}ms ` +
          '— the current holder is stuck (a re-entrant acquisition, or a ' +
          'critical section that never returned); refusing rather than hanging',
      );
    }
    try {
      return await fn();
    } finally {
      release();
      // If nothing else chained on while we held it, drop the entry so the map
      // stays bounded. (If another call chained, it replaced the tail already.)
      if (this.tails.get(group) === tail) this.tails.delete(group);
    }
  }

  /** Number of groups with a live tail. Tests only — pins that the map
   *  drains, the property the `=== tail` cleanup exists for. */
  _tailCountForTests(): number {
    return this.tails.size;
  }
}

/** The slice of the store a durable group lock needs. */
export interface GroupLockStore {
  acquireGroupLock(
    group: string,
    holder: string,
    ttlMs: number,
    now?: number,
  ): Promise<boolean>;
  releaseGroupLock(group: string, holder: string): Promise<void>;
}

export interface DurableGroupLockOpts {
  /** Identity of this process, stamped on the lock so only the holder can
   *  release it. */
  holder: string;
  /** How long a hold may last before it counts as abandoned. Must exceed the
   *  gate's critical section (a check plus a run-row insert) — NOT the run's
   *  lifetime, since the lock guards the DECISION, not the work. Default
   *  10s. */
  ttlMs?: number;
  /** Total time to keep trying before giving up. Default 5s. */
  waitMs?: number;
  /** Delay between attempts. Default 50ms. */
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * Per-group mutual exclusion that holds ACROSS PROCESSES.
 *
 * `GroupLock` serializes one process, which is all the start-gate ever had —
 * so two servers, or a server plus the standalone worker, sharing one store
 * could both pass "no active run in this group" at the same instant and both
 * create a run. This wrapper takes the in-process lock first (cheap, and it
 * keeps same-process contention off the database) and then the durable one.
 *
 * FAIL-OPEN when it cannot get the lock: it logs loudly and runs anyway. That
 * is deliberate, and matches the rule the gate already documents — the
 * concurrency layer must never break the start path. Blocking a fire forever
 * because a lock row is stuck is a worse failure than briefly allowing the
 * overlap the lock exists to prevent, and the TTL bounds "stuck" anyway.
 */
export class DurableGroupLock {
  private readonly local = new GroupLock();
  private readonly holder: string;
  private readonly ttlMs: number;
  private readonly waitMs: number;
  private readonly retryMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly store: GroupLockStore,
    opts: DurableGroupLockOpts,
  ) {
    this.holder = opts.holder;
    this.ttlMs = Math.max(1_000, opts.ttlMs ?? 10_000);
    this.waitMs = Math.max(0, opts.waitMs ?? 5_000);
    this.retryMs = Math.max(1, opts.retryMs ?? 50);
    this.sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
    this.log = opts.log ?? (() => {});
  }

  async run<T>(group: string, fn: () => Promise<T>): Promise<T> {
    return this.local.run(group, async () => {
      const held = await this.acquire(group);
      try {
        return await fn();
      } finally {
        if (held) {
          await this.store
            .releaseGroupLock(group, this.holder)
            .catch(err =>
              this.log(
                `durable group lock release for ${group} failed: ` +
                  `${(err as Error)?.message ?? err} (it will expire)`,
              ),
            );
        }
      }
    });
  }

  private async acquire(group: string): Promise<boolean> {
    const deadline = Date.now() + this.waitMs;
    for (;;) {
      try {
        if (await this.store.acquireGroupLock(group, this.holder, this.ttlMs)) {
          return true;
        }
      } catch (err) {
        // A store that cannot lock must not block the fire.
        this.log(
          `durable group lock for ${group} errored: ` +
            `${(err as Error)?.message ?? err} — proceeding WITHOUT it`,
        );
        return false;
      }
      if (Date.now() >= deadline) {
        this.log(
          `durable group lock for ${group} not acquired within ${this.waitMs}ms ` +
            '— proceeding WITHOUT it (another process holds it, so the gate may ' +
            'briefly allow an overlap rather than block the fire)',
        );
        return false;
      }
      await this.sleep(this.retryMs);
    }
  }
}
