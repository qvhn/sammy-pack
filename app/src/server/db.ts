import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import {
  assertDeliveryStatus,
  assertStatus,
  countConsecutiveFailuresNewestFirst,
  DEFAULT_LEASE_TTL_MS,
  derivePreviewFromEvents,
  interruptedEvent,
  LeaseLostError,
  type DeliveryInput,
  type DeliveryPatch,
  type DeliveryRecord,
  type DeliveryStatus,
  type PendingFire,
  type PendingFireRecord,
  summarizeRun,
  type Run,
  type RunHeader,
  type RunStatus,
  type RunStore,
  type RunStoreLeaseOpts,
  type RunSummary,
  type StoredEvent,
  type UpdateRunPatch,
  type UpsertRunInput,
} from './run-store';
import type { DegradationReason } from './degradation';
import { envPositiveInt } from './env';

/**
 * SqliteRunStore — the zero-infra RunStore backend. One `runs.db` file;
 * `npm run dev` and runs are durable. This is the default; set
 * `DATABASE_URL` to switch to Postgres (see postgres-store.ts).
 *
 * `better-sqlite3` is synchronous; the methods are `async` only to
 * satisfy the RunStore contract (the Postgres backend genuinely needs
 * async). Module is server-only — the native module won't load in the
 * browser bundle.
 */

// Re-exported so existing `import { Run } from './db'` sites keep working.
export type {
  Run,
  RunHeader,
  RunStatus,
  StoredEvent,
} from './run-store';

function parseJsonOrNull(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function toJsonOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return JSON.stringify(v);
}

/** Parse the stored `degradation_reasons` JSON back into a typed array,
 *  tolerating null / legacy-missing / malformed values (→ []). */
function parseDegradationReasons(v: unknown): DegradationReason[] {
  const parsed = parseJsonOrNull(v);
  return Array.isArray(parsed) ? (parsed as DegradationReason[]) : [];
}

function rowToHeader(row: Record<string, unknown>): RunHeader {
  const completed = parseJsonOrNull(row.completed_leaves);
  return {
    id: row.id as string,
    orchestrationName: row.orchestration_name as string,
    startedAt: row.started_at as number,
    endedAt: (row.ended_at as number | null) ?? null,
    status: row.status as RunHeader['status'],
    orchestrationSnapshot: parseJsonOrNull(row.orchestration_snapshot),
    initialInput: (row.initial_input as string | null) ?? null,
    currentPath: parseJsonOrNull(row.current_path),
    stateJson: parseJsonOrNull(row.state_json),
    lastOutput: (row.last_output as string | null) ?? null,
    pausedFor: (row.paused_for as string | null) ?? null,
    completedLeaves: Array.isArray(completed) ? (completed as string[]) : null,
    updatedAt: row.updated_at as number,
    ownerId: (row.owner_id as string | null) ?? 'system',
    concurrencyGroup: (row.concurrency_group as string | null) ?? null,
    degraded: row.degraded != null ? Number(row.degraded) === 1 : false,
    degradationReasons: parseDegradationReasons(row.degradation_reasons),
  };
}

function rowToDelivery(row: Record<string, unknown>): DeliveryRecord {
  return {
    id: row.id as string,
    kind: row.kind as string,
    name: row.name as string,
    orchestrationName: row.orchestration_name as string,
    idempotencyKey: row.idempotency_key as string,
    keySource: row.key_source as 'header' | 'auto' | 'window',
    status: row.status as DeliveryStatus,
    runId: (row.run_id as string | null) ?? null,
    body: (row.body as string | null) ?? null,
    detail: (row.detail as string | null) ?? null,
    ownerId: (row.owner_id as string | null) ?? 'system',
    receivedAt: row.received_at as number,
    firedAt: (row.fired_at as number | null) ?? null,
    attempts: (row.attempts as number | null) ?? 0,
    duplicateCount: (row.duplicate_count as number | null) ?? 0,
    claimToken: (row.claim_token as number | null) ?? 0,
    availableAt: (row.available_at as number | null) ?? 0,
    claimedAt: (row.claimed_at as number | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    chainDepth: (row.chain_depth as number | null) ?? 0,
  };
}

/** True for a SQLite UNIQUE-constraint failure. better-sqlite3 surfaces the
 *  extended result code on `err.code`. */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

/** Schema bootstrap. Idempotent. Real migrations are version-gated via
 *  PRAGMA user_version. */
function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      orchestration_name TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL,
      orchestration_snapshot TEXT,
      initial_input TEXT,
      current_path TEXT,
      state_json TEXT,
      last_output TEXT,
      paused_for TEXT,
      completed_leaves TEXT,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      concurrency_group TEXT,
      degraded INTEGER NOT NULL DEFAULT 0,
      degradation_reasons TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_status_started
      ON runs(status, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_started
      ON runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS events (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    -- NOTE: no separate index on (run_id, seq) — the PRIMARY KEY above IS
    -- that index. A duplicate cost a second B-tree write on every
    -- appendEvent and, at 100M events, multiple GB of redundant index.
    -- An existing database keeps its copy (dropping it needs a migration
    -- step and the win is space, not correctness); new ones never make it.
  `);

  const cur = (db.pragma('user_version', { simple: true }) as number) ?? 0;

  // v1: drop a legacy CHECK constraint via rename-and-recreate so
  //     'interrupted' inserts don't reject; add completed_leaves to
  //     any v0 schema that predates it.
  if (cur < 1) {
    const cols = db
      .prepare(`PRAGMA table_info(runs)`)
      .all() as Array<{ name: string }>;
    const hasCompletedLeaves = cols.some(c => c.name === 'completed_leaves');
    const tx = db.transaction(() => {
      db.exec(`
        CREATE TABLE runs_new (
          id TEXT PRIMARY KEY,
          orchestration_name TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          status TEXT NOT NULL,
          orchestration_snapshot TEXT,
          initial_input TEXT,
          current_path TEXT,
          state_json TEXT,
          last_output TEXT,
          paused_for TEXT,
          completed_leaves TEXT,
          updated_at INTEGER NOT NULL
        );
      `);
      const cl = hasCompletedLeaves
        ? 'completed_leaves'
        : 'NULL AS completed_leaves';
      db.exec(`
        INSERT INTO runs_new (
          id, orchestration_name, started_at, ended_at, status,
          orchestration_snapshot, initial_input, current_path, state_json,
          last_output, paused_for, completed_leaves, updated_at
        )
        SELECT id, orchestration_name, started_at, ended_at, status,
               orchestration_snapshot, initial_input, current_path, state_json,
               last_output, paused_for, ${cl}, updated_at
        FROM runs;
        DROP TABLE runs;
        ALTER TABLE runs_new RENAME TO runs;
        CREATE INDEX idx_runs_status_started ON runs(status, started_at DESC);
        CREATE INDEX idx_runs_started ON runs(started_at DESC);
      `);
      db.pragma('user_version = 1');
    });
    tx();
  }

  // v2: add owner_id for the multi-tenancy seam. Default 'system' so
  //     pre-existing rows show up under the single-tenant default.
  if (cur < 2) {
    const cols = db
      .prepare(`PRAGMA table_info(runs)`)
      .all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'owner_id')) {
      db.exec(
        `ALTER TABLE runs ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'system'`,
      );
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_runs_owner_started ON runs(owner_id, started_at DESC)`,
    );
    db.pragma('user_version = 2');
  }

  // v3: trigger_deliveries — durable, idempotent ingress (P0). Every
  //     trigger fire is persisted here before its run is created.
  if (cur < 3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS trigger_deliveries (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        orchestration_name TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        key_source TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT,
        body TEXT,
        detail TEXT,
        owner_id TEXT NOT NULL DEFAULT 'system',
        received_at INTEGER NOT NULL,
        fired_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_key
        ON trigger_deliveries(idempotency_key, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_deliveries_received
        ON trigger_deliveries(received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_deliveries_orch
        ON trigger_deliveries(orchestration_name, received_at DESC);
    `);
    db.pragma('user_version = 3');
  }

  // v4: queue columns on trigger_deliveries — durable work queue + worker
  //     (P1/P2) and event-chain depth (P3). SQLite can't ADD COLUMN IF NOT
  //     EXISTS, so probe PRAGMA table_info first.
  if (cur < 4) {
    const cols = db
      .prepare(`PRAGMA table_info(trigger_deliveries)`)
      .all() as Array<{ name: string }>;
    const has = (n: string) => cols.some(c => c.name === n);
    if (!has('attempts')) {
      db.exec(
        `ALTER TABLE trigger_deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!has('available_at')) {
      db.exec(
        `ALTER TABLE trigger_deliveries ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!has('claimed_at')) {
      db.exec(`ALTER TABLE trigger_deliveries ADD COLUMN claimed_at INTEGER`);
    }
    if (!has('last_error')) {
      db.exec(`ALTER TABLE trigger_deliveries ADD COLUMN last_error TEXT`);
    }
    if (!has('chain_depth')) {
      db.exec(
        `ALTER TABLE trigger_deliveries ADD COLUMN chain_depth INTEGER NOT NULL DEFAULT 0`,
      );
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_deliveries_claimable
         ON trigger_deliveries(status, available_at)`,
    );
    db.pragma('user_version = 4');
  }

  // v5: run-lease columns (multi-process safety). lease_owner = the process
  //     currently executing a run; lease_expires_at = when that lease lapses.
  //     Boot's orphan scan only reclaims expired-lease runs, so a peer/worker
  //     actively executing a run (its lease kept fresh) is never stolen.
  if (cur < 5) {
    const cols = db
      .prepare(`PRAGMA table_info(runs)`)
      .all() as Array<{ name: string }>;
    const has = (n: string) => cols.some(c => c.name === n);
    if (!has('lease_owner')) {
      db.exec(`ALTER TABLE runs ADD COLUMN lease_owner TEXT`);
    }
    if (!has('lease_expires_at')) {
      db.exec(`ALTER TABLE runs ADD COLUMN lease_expires_at INTEGER`);
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_runs_lease
         ON runs(status, lease_expires_at)`,
    );
    db.pragma('user_version = 5');
  }

  // v6: trigger_fires — cron circuit-breaker. One row per terminal trigger
  //     fire, keyed by a STABLE trigger key (e.g. cron:<orch>:<expr>). The
  //     API appends each terminal run's outcome and reads the trailing run of
  //     consecutive non-`done` outcomes to detect a silently-failing cron.
  if (cur < 6) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS trigger_fires (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trigger_fires_key
        ON trigger_fires(trigger_key, id DESC);
    `);
    db.pragma('user_version = 6');
  }

  // v7: concurrency groups — mutual exclusion for runs that share an external
  //     resource. `runs.concurrency_group` records each run's opaque group;
  //     `pending_fires` is the durable FIFO of fires parked behind a busy group
  //     under the `queue` policy, drained one-per-terminal by the run that
  //     frees the group. SQLite can't ADD COLUMN IF NOT EXISTS, so probe first.
  if (cur < 7) {
    const cols = db
      .prepare(`PRAGMA table_info(runs)`)
      .all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'concurrency_group')) {
      db.exec(`ALTER TABLE runs ADD COLUMN concurrency_group TEXT`);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runs_group_status
        ON runs(concurrency_group, status);
      CREATE TABLE IF NOT EXISTS pending_fires (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_key TEXT NOT NULL,
        orch_name TEXT NOT NULL,
        initial_input TEXT,
        owner_id TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_fires_group
        ON pending_fires(group_key, id);
    `);
    db.pragma('user_version = 7');
  }
  {
    // pending_fires.resolved_inputs — a parked fire's resolved inputs.
    const cols = db.prepare(`PRAGMA table_info(pending_fires)`).all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some(c => c.name === 'resolved_inputs')) {
      db.exec(`ALTER TABLE pending_fires ADD COLUMN resolved_inputs TEXT`);
    }
  }

  // v8: "done-but-degraded" signal — distinguish a clean `done` run from one
  //     that swallowed an error / finalized partials / took a fallback.
  //     `runs.degraded` is a 0/1 flag; `runs.degradation_reasons` is the JSON
  //     array of {phase, reason}. Computed from the event stream at terminal
  //     time (degradation.ts). SQLite can't ADD COLUMN IF NOT EXISTS, so probe.
  if (cur < 8) {
    const cols = db
      .prepare(`PRAGMA table_info(runs)`)
      .all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'degraded')) {
      db.exec(
        `ALTER TABLE runs ADD COLUMN degraded INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!cols.some(c => c.name === 'degradation_reasons')) {
      db.exec(`ALTER TABLE runs ADD COLUMN degradation_reasons TEXT`);
    }
    db.pragma('user_version = 8');
  }

  // v9: delivery CLAIM FENCING + header-key uniqueness.
  //
  //   claim_token — a monotonic counter bumped on every claim, and the fence
  //     every terminal update must present. Runs have had lease fencing for a
  //     while; deliveries had none, so their terminal writes were `WHERE id =
  //     ?` and a worker that stalled past the reclaim window could finish and
  //     stamp its result over the delivery another worker had already
  //     re-claimed and run — two live runs from one accepted fire.
  //     `attempts` cannot serve as the fence because `replayDelivery` resets
  //     it to 0, and a fence that can be reused is not a fence.
  //
  //   uq_deliveries_header_key — a header Idempotency-Key is unique FOREVER,
  //     and the dedupe was check-then-insert with no constraint behind it, so
  //     two simultaneous posts of one key both saw zero priors and both
  //     inserted. PARTIAL (header keys only) because auto keys are windowed
  //     and are *supposed* to repeat outside the window; keyed per
  //     orchestration because one fire legitimately fans out to a row per
  //     subscriber, all sharing the key.
  if (cur < 9) {
    const cols = db
      .prepare(`PRAGMA table_info(trigger_deliveries)`)
      .all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'claim_token')) {
      db.exec(
        `ALTER TABLE trigger_deliveries ADD COLUMN claim_token INTEGER NOT NULL DEFAULT 0`,
      );
    }
    try {
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_deliveries_header_key
           ON trigger_deliveries(idempotency_key, orchestration_name)
           WHERE key_source = 'header'`,
      );
    } catch (err) {
      // An existing database may already hold duplicate rows produced by the
      // very race this index prevents. Refusing to boot over historical data
      // would be worse than the race, so fall back to a non-unique index:
      // dedupe stays best-effort on THIS database (as it has been all along)
      // while every clean one gets the guarantee.
      // eslint-disable-next-line no-console
      console.warn(
        '[sammy-pack-db] could not add the unique index on header idempotency ' +
          `keys (${(err as Error)?.message ?? err}). This database already ` +
          'contains duplicate (idempotency_key, orchestration_name) rows, so ' +
          'concurrent double-fires of one key cannot be prevented at the ' +
          'storage layer here. Find them with:\n' +
          "  SELECT idempotency_key, orchestration_name, COUNT(*) c FROM trigger_deliveries\n" +
          "   WHERE key_source='header' GROUP BY 1,2 HAVING c > 1;",
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_deliveries_header_key
           ON trigger_deliveries(idempotency_key, orchestration_name)`,
      );
    }
    db.pragma('user_version = 9');
  }

  // v10: a REFUSED delivery must not consume its idempotency key.
  //
  // v9's index covered every status, so one `rejected` or `failed` row
  // claimed that key forever: a sender retrying after the cause was fixed
  // (budget cap lifted, orchestration redeployed) got a 200/duplicate and
  // its event was never run. A provider's own retry of a delivery we had
  // refused was therefore silently dropped.
  //
  // Narrowing the predicate to non-refused statuses keeps the protection
  // that matters — at most one LIVE-or-FIRED row per key per orchestration,
  // so two concurrent posts still cannot both create work — while letting a
  // refusal be retried. It also makes it safe to RECORD a queue-full refusal
  // instead of dropping it silently, which is what cron and publishEvent
  // needed (they have no 429 to receive).
  if (cur < 10) {
    db.exec(`DROP INDEX IF EXISTS uq_deliveries_header_key`);
    try {
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_deliveries_header_key
           ON trigger_deliveries(idempotency_key, orchestration_name)
           WHERE key_source = 'header'
             AND status NOT IN ('rejected', 'failed')`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[sammy-pack-db] could not add the unique index on ACTIVE header ' +
          `idempotency keys (${(err as Error)?.message ?? err}). Concurrent ` +
          'double-fires of one key cannot be prevented at the storage layer ' +
          'on this database.',
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_deliveries_header_key
           ON trigger_deliveries(idempotency_key, orchestration_name)`,
      );
    }
    db.pragma('user_version = 10');
  }

  // v11: DURABLE concurrency-group locks, for cross-process exclusion.
  //
  // The start-gate's atomicity came from `GroupLock`, an IN-MEMORY mutex, so
  // two server processes — or a server plus a standalone worker — sharing one
  // store could both pass "no active run in this group" at the same instant
  // and both create a run. The store-level check narrows the window; it does
  // not close it. This table does: acquiring is a single atomic upsert that
  // only succeeds against an absent or EXPIRED row.
  //
  // `expires_at` is what makes it crash-safe. A holder that dies never
  // releases, so a lock without a TTL would wedge its group permanently —
  // strictly worse than the race it set out to fix.
  if (cur < 11) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS concurrency_group_locks (
        group_key TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_group_locks_expiry
        ON concurrency_group_locks(expires_at);
    `);
    db.pragma('user_version = 11');
  }

  // v12: count suppressed duplicates ON the surviving row.
  //
  // `'duplicate'` is a valid DeliveryStatus that NOTHING ever wrote: a
  // suppressed fire was reported as duplicate in the HTTP response and left
  // no trace at all, so the stats endpoint's duplicate bucket was
  // permanently 0 and a provider double-sending was invisible.
  //
  // A row per suppressed fire would be the obvious fix and is the wrong one:
  // it is unbounded writes driven by whoever is retrying. Incrementing a
  // counter on the row that WON the key is bounded, and answers the question
  // that actually matters — "how many times has this fire been re-sent".
  if (cur < 12) {
    const cols = db
      .prepare(`PRAGMA table_info(trigger_deliveries)`)
      .all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'duplicate_count')) {
      db.exec(
        `ALTER TABLE trigger_deliveries
           ADD COLUMN duplicate_count INTEGER NOT NULL DEFAULT 0`,
      );
    }
    db.pragma('user_version = 12');
  }
}

export class SqliteRunStore implements RunStore {
  readonly backend = 'sqlite' as const;
  private db!: Database.Database;
  private readonly file: string;
  /** This process's lease identity — stamped on runs it executes so a peer's
   *  boot scan can tell a live run from an orphaned one. (SQLite is usually
   *  single-process, but the standalone worker can share one runs.db.) */
  private readonly instanceId: string;
  private readonly leaseTtlMs: number;

  constructor(repoRoot: string, opts?: RunStoreLeaseOpts) {
    this.file = path.join(repoRoot, 'runs.db');
    this.instanceId = opts?.instanceId ?? randomUUID();
    this.leaseTtlMs = opts?.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  /** Where the database lives — for the boot banner (path + size) and the
   *  retention sweep's reclaimed-bytes measurement. */
  get filePath(): string {
    return this.file;
  }

  /** Open the handle + run migrations. Async only to match the
   *  RunStore contract — the work itself is synchronous. */
  async init(): Promise<void> {
    const db = new Database(this.file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
    this.db = db;
  }

  async listRuns(limit = 500, ownerId?: string): Promise<RunHeader[]> {
    if (ownerId) {
      return this.db
        .prepare<[string, number]>(
          `SELECT * FROM runs WHERE owner_id = ? ORDER BY started_at DESC LIMIT ?`,
        )
        .all(ownerId, limit)
        .map(r => rowToHeader(r as Record<string, unknown>));
    }
    return this.db
      .prepare<[number]>(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`)
      .all(limit)
      .map(r => rowToHeader(r as Record<string, unknown>));
  }

  async listPausedRuns(): Promise<RunHeader[]> {
    // Deliberately UNBOUNDED, unlike listRuns: the sweepers (stale gates,
    // due waits) must see EVERY paused run, and listRuns's newest-500
    // window silently hid old ones on a busy store — a wait-park beyond
    // the window never resumed; an abandoned gate held its concurrency
    // group forever. Paused runs are inherently few (each is a held gate
    // or a parked wait), so the scan stays small even when `runs` is not.
    return this.db
      .prepare(`SELECT * FROM runs WHERE status = 'paused' ORDER BY started_at DESC`)
      .all()
      .map(r => rowToHeader(r as Record<string, unknown>));
  }

  async getRun(id: string, ownerId?: string): Promise<Run | null> {
    const headerRow = this.db
      .prepare<[string]>(`SELECT * FROM runs WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    if (!headerRow) return null;
    const header = rowToHeader(headerRow);
    // Owner scope = authorization. A mismatch reads as MISSING, not
    // forbidden, so the response cannot be used to enumerate run ids.
    if (ownerId !== undefined && header.ownerId !== ownerId) return null;
    const eventRows = this.db
      .prepare<[string]>(
        `SELECT event_json FROM events WHERE run_id = ? ORDER BY seq ASC`,
      )
      .all(id) as Array<{ event_json: string }>;
    const events: StoredEvent[] = eventRows.map(r => JSON.parse(r.event_json));
    return { ...header, events, eventVersion: events.length };
  }

  async getRunSummary(id: string, ownerId?: string): Promise<RunSummary | null> {
    const headerRow = this.db
      .prepare<[string]>(`SELECT * FROM runs WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    if (!headerRow) return null;
    const header = rowToHeader(headerRow);
    if (ownerId !== undefined && header.ownerId !== ownerId) return null;
    // Read just enough to tally — bodies are parsed but never returned (the
    // whole point is to NOT ship events[]). Ordered by seq so the last row is
    // the latest event.
    const eventRows = this.db
      .prepare<[string]>(
        `SELECT event_json FROM events WHERE run_id = ? ORDER BY seq ASC`,
      )
      .all(id) as Array<{ event_json: string }>;
    const events: StoredEvent[] = eventRows.map(r => JSON.parse(r.event_json));
    return summarizeRun(header, events);
  }

  async eventCounts(runIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (runIds.length === 0) return out;
    // One grouped count over the (run_id, seq) index — no event bodies read.
    // SQLite caps host parameters (~999/32766), so chunk the IN list.
    const CHUNK = 500;
    for (let i = 0; i < runIds.length; i += CHUNK) {
      const chunk = runIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare<string[]>(
          `SELECT run_id, COUNT(*) AS n FROM events
             WHERE run_id IN (${placeholders}) GROUP BY run_id`,
        )
        .all(...chunk) as Array<{ run_id: string; n: number }>;
      for (const r of rows) out.set(r.run_id, Number(r.n));
    }
    return out;
  }

  async upsertRun(run: UpsertRunInput): Promise<void> {
    assertStatus(run.status);
    const now = Date.now();
    // A run upserted as `running` is owned by this process from the outset —
    // claim the lease so a concurrent boot scan can't reclaim it before the
    // first event lands.
    const leaseOwner = run.status === 'running' ? this.instanceId : null;
    const leaseExpiresAt =
      run.status === 'running' ? now + this.leaseTtlMs : null;
    // Denormalize the recent-output preview so the LIST endpoint can ship a
    // snippet without loading events (the OOM fix). Whole-run upsert is the
    // browser-saved path; the run-controller's live path sets last_output via
    // updateRunStatus on phase-end.
    const lastOutput = derivePreviewFromEvents(run.events);
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO runs (
            id, orchestration_name, started_at, ended_at, status,
            orchestration_snapshot, initial_input, owner_id,
            last_output, lease_owner, lease_expires_at, concurrency_group,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            orchestration_name = excluded.orchestration_name,
            started_at = excluded.started_at,
            ended_at = excluded.ended_at,
            status = excluded.status,
            orchestration_snapshot = excluded.orchestration_snapshot,
            initial_input = excluded.initial_input,
            owner_id = excluded.owner_id,
            last_output = excluded.last_output,
            lease_owner = excluded.lease_owner,
            lease_expires_at = excluded.lease_expires_at,
            concurrency_group = excluded.concurrency_group,
            updated_at = excluded.updated_at`,
        )
        .run(
          run.id,
          run.orchestrationName,
          run.startedAt,
          run.endedAt ?? null,
          run.status,
          toJsonOrNull(run.orchestrationSnapshot),
          run.initialInput ?? null,
          run.ownerId ?? 'system',
          lastOutput,
          leaseOwner,
          leaseExpiresAt,
          run.concurrencyGroup ?? null,
          now,
        );
      this.db.prepare(`DELETE FROM events WHERE run_id = ?`).run(run.id);
      const insertEvent = this.db.prepare(
        `INSERT INTO events (run_id, seq, event_json, ts) VALUES (?, ?, ?, ?)`,
      );
      let seq = 0;
      for (const ev of run.events) {
        const ts =
          typeof ev.ts === 'number' && Number.isFinite(ev.ts) ? ev.ts : now;
        insertEvent.run(run.id, seq, JSON.stringify(ev), ts);
        seq += 1;
      }
    });
    tx();
  }

  async appendEvent(runId: string, event: StoredEvent): Promise<void> {
    const ts =
      typeof event.ts === 'number' && Number.isFinite(event.ts)
        ? event.ts
        : Date.now();
    const tx = this.db.transaction(() => {
      // Fence: while a run is RUNNING, only its lease owner may write events —
      // a peer that reclaimed it (we stalled past the TTL) is the single
      // writer, so our stale write is rejected, not silently accepted (the
      // whole txn rolls back on throw). The fence is scoped to running runs
      // because that's the only state with an active executor to collide with;
      // writes to a paused/interrupted run (e.g. an A2A follow-up message
      // before resume) are legitimately cross-process and stay allowed.
      const row = this.db
        .prepare<[string]>(`SELECT status, lease_owner FROM runs WHERE id = ?`)
        .get(runId) as
        | { status: string; lease_owner: string | null }
        | undefined;
      if (!row) throw new LeaseLostError(runId, this.instanceId, null);
      if (row.status === 'running' && row.lease_owner !== this.instanceId) {
        throw new LeaseLostError(runId, this.instanceId, row.lease_owner);
      }
      const next = this.db
        .prepare<[string]>(
          `SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM events WHERE run_id = ?`,
        )
        .get(runId) as { next: number };
      this.db
        .prepare(
          `INSERT INTO events (run_id, seq, event_json, ts) VALUES (?, ?, ?, ?)`,
        )
        .run(runId, next.next, JSON.stringify(event), ts);
      // Heartbeat: every event this process writes pushes the lease forward,
      // so an actively-executing run is never seen as orphaned by a peer boot.
      const heartbeat = Date.now();
      this.db
        .prepare(
          `UPDATE runs
             SET updated_at = ?, lease_owner = ?, lease_expires_at = ?
           WHERE id = ?`,
        )
        .run(heartbeat, this.instanceId, heartbeat + this.leaseTtlMs, runId);
    });
    tx();
  }

  async deleteRun(id: string, ownerId?: string): Promise<boolean> {
    // The owner predicate is IN the DELETE, not a preceding SELECT: a
    // check-then-act would leave a window where the row's owner changed
    // between the two statements. `immediate()` for the same reason the
    // delivery claim uses it — this reads then writes.
    const tx = this.db.transaction(() => {
      if (ownerId !== undefined) {
        const res = this.db
          .prepare(`DELETE FROM runs WHERE id = ? AND owner_id = ?`)
          .run(id, ownerId);
        if (res.changes === 0) return false;
        this.db.prepare(`DELETE FROM events WHERE run_id = ?`).run(id);
        return true;
      }
      this.db.prepare(`DELETE FROM events WHERE run_id = ?`).run(id);
      const res = this.db.prepare(`DELETE FROM runs WHERE id = ?`).run(id);
      return res.changes > 0;
    });
    return tx.immediate();
  }

  async updateRunStatus(
    id: string,
    patch: UpdateRunPatch,
    opts?: { requireLease?: boolean; onlyIfStatus?: RunStatus[] },
  ): Promise<boolean> {
    if (patch.status !== undefined) assertStatus(patch.status);
    for (const s of opts?.onlyIfStatus ?? []) assertStatus(s);
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const args: unknown[] = [now];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      args.push(patch.status);
    }
    // Resuming a run (-> running) claims the lease for this process.
    if (patch.status === 'running') {
      sets.push('lease_owner = ?', 'lease_expires_at = ?');
      args.push(this.instanceId, now + this.leaseTtlMs);
    }
    if (patch.endedAt !== undefined) {
      sets.push('ended_at = ?');
      args.push(patch.endedAt);
    }
    if (patch.currentPath !== undefined) {
      sets.push('current_path = ?');
      args.push(toJsonOrNull(patch.currentPath));
    }
    if (patch.stateJson !== undefined) {
      sets.push('state_json = ?');
      args.push(toJsonOrNull(patch.stateJson));
    }
    if (patch.lastOutput !== undefined) {
      sets.push('last_output = ?');
      args.push(patch.lastOutput);
    }
    if (patch.pausedFor !== undefined) {
      sets.push('paused_for = ?');
      args.push(patch.pausedFor);
    }
    if (patch.completedLeaves !== undefined) {
      sets.push('completed_leaves = ?');
      args.push(toJsonOrNull(patch.completedLeaves));
    }
    if (patch.degraded !== undefined) {
      sets.push('degraded = ?');
      args.push(patch.degraded ? 1 : 0);
    }
    if (patch.degradationReasons !== undefined) {
      sets.push('degradation_reasons = ?');
      args.push(toJsonOrNull(patch.degradationReasons));
    }
    args.push(id);
    // Preconditions live IN the UPDATE (see the RunStore doc). The lease
    // fence is renewLease's own predicate — owner AND still running — rather
    // than the looser `owner OR not running` appendEvent uses: a checkpoint
    // is a wholesale overwrite, and the looser form would let a de-leased
    // owner stomp a run its peer had already resumed and re-paused.
    const where: string[] = ['id = ?'];
    if (opts?.requireLease) {
      where.push(`lease_owner = ? AND status = 'running'`);
      args.push(this.instanceId);
    }
    if (opts?.onlyIfStatus && opts.onlyIfStatus.length > 0) {
      where.push(`status IN (${opts.onlyIfStatus.map(() => '?').join(', ')})`);
      args.push(...opts.onlyIfStatus);
    }
    const res = this.db
      .prepare(`UPDATE runs SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`)
      .run(...args);
    if (res.changes > 0) return true;
    if (opts?.requireLease) {
      const row = this.db
        .prepare<[string]>(`SELECT lease_owner FROM runs WHERE id = ?`)
        .get(id) as { lease_owner: string | null } | undefined;
      throw new LeaseLostError(id, this.instanceId, row?.lease_owner ?? null);
    }
    return false;
  }

  async markOrphanedRunsAsInterrupted(
    now: number = Date.now(),
    opts?: { isLocallyActive?: (id: string) => boolean },
  ): Promise<{ count: number; ids: string[] }> {
    // Only reclaim runs whose lease has expired (owner died). A run a live
    // peer is executing keeps its lease ahead of `now` and is left alone —
    // and so is a run THIS process owns, however stale its lease: a blocked
    // event loop is not a dead process, and its next renew recovers the lease
    // (see the RunStore doc). At boot the exclusion is a no-op (fresh id).
    //
    // The own-row exclusion protects a LIVE run. When the caller can say which
    // of its rows it still drives (`isLocallyActive`), own rows are fetched
    // too and judged here, per row: one it has let go of — a leg whose
    // terminal write failed every retry, heartbeat stopped — is an orphan
    // like a dead peer's, and in a single-process deployment nothing else
    // would ever free it. Without a predicate the SQL excludes them outright.
    const ownRowIsOrphan = (id: string): boolean =>
      opts?.isLocallyActive !== undefined && !opts.isLocallyActive(id);
    const fetchOwn = opts?.isLocallyActive !== undefined ? 1 : 0;
    const rows = (
      this.db
        .prepare<[number, string, number]>(
          `SELECT id, lease_owner, lease_expires_at FROM runs
             WHERE status = 'running'
               AND (lease_expires_at IS NULL OR lease_expires_at < ?)
               AND (lease_owner IS NULL OR lease_owner <> ? OR ? = 1)`,
        )
        .all(now, this.instanceId, fetchOwn) as Array<{
        id: string;
        lease_owner: string | null;
        lease_expires_at: number | null;
      }>
    ).filter(r => r.lease_owner !== this.instanceId || ownRowIsOrphan(r.id));
    if (rows.length === 0) return { count: 0, ids: [] };
    const reclaimed: string[] = [];
    const tx = this.db.transaction(() => {
      // Atomic reclaim: re-check the lease IN the UPDATE so a heartbeat that
      // landed between the SELECT and here makes it a no-op (rows changed = 0)
      // — we don't steal a run that just came back to life — and re-check
      // the owner the SELECT saw (null-safe `IS`), so a re-lease in that gap
      // cannot outrun the exclusion above. Clearing lease_owner fences out
      // the old (presumed-dead) owner immediately: its next appendEvent sees
      // a non-matching owner and yields.
      const upd = this.db.prepare(
        `UPDATE runs
           SET status = 'interrupted', ended_at = ?, updated_at = ?,
               lease_owner = NULL
         WHERE id = ?
           AND status = 'running'
           AND (lease_expires_at IS NULL OR lease_expires_at < ?)
           AND lease_owner IS ?`,
      );
      const seq = this.db.prepare<[string]>(
        `SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM events WHERE run_id = ?`,
      );
      const ins = this.db.prepare(
        `INSERT INTO events (run_id, seq, event_json, ts) VALUES (?, ?, ?, ?)`,
      );
      for (const r of rows) {
        const res = upd.run(now, now, r.id, now, r.lease_owner);
        if (res.changes === 0) continue; // came back to life — leave it
        reclaimed.push(r.id);
        const next = (seq.get(r.id) as { next: number }).next;
        ins.run(
          r.id,
          next,
          JSON.stringify(
            interruptedEvent(r.lease_owner, r.lease_expires_at, this.instanceId, now),
          ),
          now,
        );
      }
    });
    tx();
    return { count: reclaimed.length, ids: reclaimed };
  }

  async renewLease(id: string): Promise<boolean> {
    // Fenced: only renew if we still own it AND it's still running.
    const now = Date.now();
    const res = this.db
      .prepare(
        `UPDATE runs SET lease_expires_at = ?
           WHERE id = ? AND lease_owner = ? AND status = 'running'`,
      )
      .run(now + this.leaseTtlMs, id, this.instanceId);
    return res.changes > 0;
  }

  async recordDelivery(input: DeliveryInput): Promise<boolean> {
    const status = input.status ?? 'accepted';
    assertDeliveryStatus(status);
    try {
      this.insertDelivery(input, status);
      return true;
    } catch (err) {
      // The partial unique index on (idempotency_key, orchestration_name)
      // rejected a duplicate header key. That is the dedupe working, not an
      // error: a concurrent double-post of one key now loses the race here
      // instead of both inserting.
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  private insertDelivery(input: DeliveryInput, status: DeliveryStatus): void {
    this.db
      .prepare(
        `INSERT INTO trigger_deliveries (
           id, kind, name, orchestration_name, idempotency_key, key_source,
           status, run_id, body, detail, owner_id, received_at, fired_at,
           attempts, available_at, claimed_at, last_error, chain_depth
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.kind,
        input.name,
        input.orchestrationName,
        input.idempotencyKey,
        input.keySource,
        status,
        input.runId ?? null,
        input.body ?? null,
        input.detail ?? null,
        input.ownerId ?? 'system',
        input.receivedAt,
        null,
        0,
        input.availableAt ?? input.receivedAt,
        null,
        null,
        input.chainDepth ?? 0,
      );
  }

  async findDeliveriesByKey(
    key: string,
    opts?: { sinceMs?: number; excludeRefused?: boolean; now?: number },
  ): Promise<DeliveryRecord[]> {
    const where = ['idempotency_key = ?'];
    const args: unknown[] = [key];
    if (opts?.sinceMs != null) {
      where.push('received_at >= ?');
      args.push((opts.now ?? Date.now()) - opts.sinceMs);
    }
    if (opts?.excludeRefused) {
      // Matches the partial unique index's predicate, so the dedupe READ and
      // the storage CONSTRAINT agree about which rows own a key.
      where.push("status NOT IN ('rejected', 'failed')");
    }
    return this.db
      .prepare(
        `SELECT * FROM trigger_deliveries
          WHERE ${where.join(' AND ')}
          ORDER BY received_at DESC`,
      )
      .all(...args)
      .map(r => rowToDelivery(r as Record<string, unknown>));
  }

  async updateDelivery(id: string, patch: DeliveryPatch): Promise<void> {
    if (patch.status !== undefined) assertDeliveryStatus(patch.status);
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      args.push(patch.status);
    }
    if (patch.runId !== undefined) {
      sets.push('run_id = ?');
      args.push(patch.runId);
    }
    if (patch.detail !== undefined) {
      sets.push('detail = ?');
      args.push(patch.detail);
    }
    if (patch.firedAt !== undefined) {
      sets.push('fired_at = ?');
      args.push(patch.firedAt);
    }
    if (sets.length === 0) return;
    args.push(id);
    this.db
      .prepare(`UPDATE trigger_deliveries SET ${sets.join(', ')} WHERE id = ?`)
      .run(...args);
  }

  async findLastPollingDelivery(
    source: string,
    orchestrationName: string,
  ): Promise<DeliveryRecord | null> {
    // Indexed by the query planner off the kind/name predicate; LIMIT 1 so
    // this stays O(1)-ish however large the table grows.
    const row = this.db
      .prepare(
        `SELECT * FROM trigger_deliveries
          WHERE kind = 'polling' AND name = ? AND orchestration_name = ?
          ORDER BY received_at DESC LIMIT 1`,
      )
      .get(source, orchestrationName);
    return row ? rowToDelivery(row as Record<string, unknown>) : null;
  }

  async listDeliveries(
    limit = 200,
    ownerId?: string,
    status?: DeliveryStatus,
  ): Promise<DeliveryRecord[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (ownerId) {
      where.push('owner_id = ?');
      args.push(ownerId);
    }
    if (status) {
      assertDeliveryStatus(status);
      where.push('status = ?');
      args.push(status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    args.push(limit);
    return this.db
      .prepare(
        `SELECT * FROM trigger_deliveries ${clause} ORDER BY received_at DESC LIMIT ?`,
      )
      .all(...args)
      .map(r => rowToDelivery(r as Record<string, unknown>));
  }

  async claimNextDelivery(
    now: number,
    opts?: { maxInFlightPerOrch?: number },
  ): Promise<DeliveryRecord | null> {
    const cap = opts?.maxInFlightPerOrch;
    // IMMEDIATE, not the default DEFERRED. A deferred transaction starts
    // read-only and upgrades on first write, and when two processes share
    // this file (the standalone worker is explicitly supported) the loser of
    // that upgrade gets SQLITE_BUSY_SNAPSHOT — an error class `busy_timeout`
    // does NOT retry, so the claim simply threw and the loop slept. Taking
    // the write lock up front makes the contention a wait that busy_timeout
    // handles. Snapshot isolation already prevented a double-claim, so this
    // buys throughput and quiet logs, not correctness.
    const tx = this.db.transaction((): Record<string, unknown> | null => {
      const row =
        cap != null
          ? (this.db
              .prepare<[number, number]>(
                `SELECT d.* FROM trigger_deliveries d
                  WHERE d.status = 'pending' AND d.available_at <= ?
                    AND (
                      SELECT COUNT(*) FROM trigger_deliveries c
                       WHERE c.orchestration_name = d.orchestration_name
                         AND c.status = 'claimed'
                    ) < ?
                  ORDER BY d.received_at ASC LIMIT 1`,
              )
              .get(now, cap) as Record<string, unknown> | undefined)
          : (this.db
              .prepare<[number]>(
                `SELECT * FROM trigger_deliveries
                  WHERE status = 'pending' AND available_at <= ?
                  ORDER BY received_at ASC LIMIT 1`,
              )
              .get(now) as Record<string, unknown> | undefined);
      if (!row) return null;
      this.db
        .prepare(
          `UPDATE trigger_deliveries
             SET status = 'claimed', claimed_at = ?, attempts = attempts + 1,
                 claim_token = claim_token + 1
           WHERE id = ?`,
        )
        .run(now, row.id);
      return this.db
        .prepare<[string]>(`SELECT * FROM trigger_deliveries WHERE id = ?`)
        .get(row.id as string) as Record<string, unknown>;
    });
    const claimed = tx.immediate();
    return claimed ? rowToDelivery(claimed) : null;
  }

  async completeDelivery(
    id: string,
    runId: string,
    now: number,
    claimToken: number,
  ): Promise<boolean> {
    // FENCED on (still claimed, same token): a worker that stalled past the
    // reclaim window must not stamp its result over the delivery someone
    // else re-claimed and ran.
    const res = this.db
      .prepare(
        `UPDATE trigger_deliveries
           SET status = 'fired', run_id = ?, fired_at = ?, claimed_at = NULL,
               last_error = NULL
         WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
      )
      .run(runId, now, id, claimToken);
    return res.changes > 0;
  }

  async deferDelivery(
    id: string,
    detail: string,
    _now: number,
    claimToken: number,
  ): Promise<boolean> {
    const res = this.db
      .prepare(
        `UPDATE trigger_deliveries
           SET status = 'deferred', detail = ?, claimed_at = NULL
         WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
      )
      .run(detail, id, claimToken);
    return res.changes > 0;
  }

  async rejectDelivery(
    id: string,
    reason: string,
    _now: number,
    claimToken: number,
  ): Promise<boolean> {
    const res = this.db
      .prepare(
        `UPDATE trigger_deliveries
           SET status = 'rejected', last_error = ?, claimed_at = NULL
         WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
      )
      .run(reason, id, claimToken);
    return res.changes > 0;
  }

  async failDelivery(
    id: string,
    opts: {
      error: string;
      now: number;
      retryAt?: number | null;
      claimToken: number;
    },
  ): Promise<boolean> {
    if (opts.retryAt != null) {
      const res = this.db
        .prepare(
          `UPDATE trigger_deliveries
             SET status = 'pending', available_at = ?, last_error = ?,
                 claimed_at = NULL
           WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
        )
        .run(opts.retryAt, opts.error, id, opts.claimToken);
      return res.changes > 0;
    }
    const res = this.db
      .prepare(
        `UPDATE trigger_deliveries
           SET status = 'failed', last_error = ?, claimed_at = NULL
         WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
      )
      .run(opts.error, id, opts.claimToken);
    return res.changes > 0;
  }

  async releaseDeliveries(orchestrationName: string, now: number): Promise<number> {
    const res = this.db
      .prepare(
        `UPDATE trigger_deliveries SET available_at = ?
          WHERE orchestration_name = ? AND status = 'pending' AND available_at > ?`,
      )
      .run(now, orchestrationName, now);
    return res.changes;
  }

  async holdDelivery(
    id: string,
    opts: { until: number; detail: string; claimToken: number },
  ): Promise<boolean> {
    const res = this.db
      .prepare(
        `UPDATE trigger_deliveries
           SET status = 'pending', available_at = ?, detail = ?,
               attempts = MAX(attempts - 1, 0), claimed_at = NULL, last_error = NULL
         WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
      )
      .run(opts.until, opts.detail, id, opts.claimToken);
    return res.changes > 0;
  }

  async reclaimStaleDeliveries(
    olderThanMs: number,
    now: number,
  ): Promise<{ count: number; ids: string[] }> {
    const cutoff = now - olderThanMs;
    // The select and the update must be ONE atomic step, and the update must
    // re-check the predicate. Selecting ids outside a transaction and then
    // updating by id alone let a peer process (the standalone worker shares
    // this db) settle a delivery in the gap — and the unguarded update then
    // forced an already-`fired` row back to `pending`, re-running it.
    const upd = this.db.prepare<[string, number]>(
      `UPDATE trigger_deliveries
         SET status = 'pending', claimed_at = NULL
       WHERE id = ? AND status = 'claimed' AND claimed_at IS NOT NULL
         AND claimed_at < ?`,
    );
    const tx = this.db.transaction((): string[] => {
      const rows = this.db
        .prepare<[number]>(
          `SELECT id FROM trigger_deliveries
            WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ?`,
        )
        .all(cutoff) as Array<{ id: string }>;
      const reclaimed: string[] = [];
      for (const r of rows) {
        // Only count rows the guarded update actually moved.
        if (upd.run(r.id, cutoff).changes > 0) {
          reclaimed.push(r.id);
        }
      }
      return reclaimed;
    });
    const ids = tx();
    return { count: ids.length, ids };
  }

  async replayDelivery(id: string, now: number): Promise<boolean> {
    const res = this.db
      .prepare(
        `UPDATE trigger_deliveries
           SET status = 'pending', available_at = ?, claimed_at = NULL,
               attempts = 0, last_error = NULL
         WHERE id = ? AND status IN ('failed', 'rejected')`,
      )
      .run(now, id);
    return res.changes > 0;
  }

  async countDeliveries(filter?: {
    status?: DeliveryStatus;
    orchestrationName?: string;
    ownerId?: string;
    /** Only rows claimable at or before this epoch ms. */
    availableBefore?: number;
    /** Due, or backing off after a failed attempt — not held. */
    dueOrRetrying?: number;
  }): Promise<number> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter?.status) {
      assertDeliveryStatus(filter.status);
      where.push('status = ?');
      args.push(filter.status);
    }
    if (filter?.orchestrationName) {
      where.push('orchestration_name = ?');
      args.push(filter.orchestrationName);
    }
    if (filter?.ownerId) {
      where.push('owner_id = ?');
      args.push(filter.ownerId);
    }
    if (filter?.availableBefore !== undefined) {
      where.push('available_at <= ?');
      args.push(filter.availableBefore);
    }
    if (filter?.dueOrRetrying !== undefined) {
      where.push('(available_at <= ? OR last_error IS NOT NULL)');
      args.push(filter.dueOrRetrying);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM trigger_deliveries ${clause}`)
      .get(...args) as { n: number };
    return row.n;
  }

  async findDeliveryByRunId(runId: string): Promise<DeliveryRecord | null> {
    const row = this.db
      .prepare<[string]>(
        `SELECT * FROM trigger_deliveries WHERE run_id = ? LIMIT 1`,
      )
      .get(runId) as Record<string, unknown> | undefined;
    return row ? rowToDelivery(row) : null;
  }

  async recordTriggerOutcome(
    triggerKey: string,
    runId: string,
    status: string,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO trigger_fires (trigger_key, run_id, status, ts)
           VALUES (?, ?, ?, ?)`,
      )
      .run(triggerKey, runId, status, Date.now());
  }

  async getConsecutiveFailures(triggerKey: string): Promise<number> {
    // Newest-first by the autoincrement id (insertion order, monotonic even
    // when two fires share a ms `ts`). Stop at the first `done`. Reading only
    // the trailing failure window would need a correlated subquery; a workspace
    // never accrues enough fires per key for the full-key scan to matter.
    const rows = this.db
      .prepare<[string]>(
        `SELECT status FROM trigger_fires
          WHERE trigger_key = ?
          ORDER BY id DESC`,
      )
      .all(triggerKey) as Array<{ status: string }>;
    return countConsecutiveFailuresNewestFirst(rows);
  }

  async findActiveRunsInGroup(
    group: string,
    excludeRunId?: string,
  ): Promise<RunHeader[]> {
    const rows = excludeRunId
      ? (this.db
          .prepare<[string, string]>(
            `SELECT * FROM runs
              WHERE concurrency_group = ?
                AND status IN ('running', 'paused')
                AND id != ?
              ORDER BY started_at ASC`,
          )
          .all(group, excludeRunId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare<[string]>(
            `SELECT * FROM runs
              WHERE concurrency_group = ?
                AND status IN ('running', 'paused')
              ORDER BY started_at ASC`,
          )
          .all(group) as Array<Record<string, unknown>>);
    return rows.map(rowToHeader);
  }

  async noteDuplicateSuppressed(id: string): Promise<void> {
    this.db
      .prepare<[string]>(
        `UPDATE trigger_deliveries
           SET duplicate_count = duplicate_count + 1
         WHERE id = ?`,
      )
      .run(id);
  }

  async sumDuplicatesSuppressed(ownerId?: string): Promise<number> {
    const row = (
      ownerId
        ? this.db
            .prepare<[string]>(
              `SELECT COALESCE(SUM(duplicate_count), 0) AS n FROM trigger_deliveries WHERE owner_id = ?`,
            )
            .get(ownerId)
        : this.db
            .prepare(`SELECT COALESCE(SUM(duplicate_count), 0) AS n FROM trigger_deliveries`)
            .get()
    ) as { n: number };
    return Number(row?.n ?? 0);
  }

  async acquireGroupLock(
    group: string,
    holder: string,
    ttlMs: number,
    now: number = Date.now(),
  ): Promise<boolean> {
    // Single atomic upsert. The DO UPDATE's WHERE is the whole mechanism: on
    // a conflict with an UNEXPIRED row it matches nothing, so `changes` is 0
    // and we did not get the lock.
    const res = this.db
      .prepare<[string, string, number, number, number]>(
        `INSERT INTO concurrency_group_locks
           (group_key, holder, acquired_at, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(group_key) DO UPDATE SET
           holder = excluded.holder,
           acquired_at = excluded.acquired_at,
           expires_at = excluded.expires_at
         WHERE concurrency_group_locks.expires_at <= ?`,
      )
      .run(group, holder, now, now + ttlMs, now);
    return res.changes > 0;
  }

  async releaseGroupLock(group: string, holder: string): Promise<void> {
    this.db
      .prepare<[string, string]>(
        `DELETE FROM concurrency_group_locks
          WHERE group_key = ? AND holder = ?`,
      )
      .run(group, holder);
  }

  async enqueuePendingFire(group: string, fire: PendingFire): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO pending_fires (group_key, orch_name, initial_input, owner_id, ts, resolved_inputs)
           VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        group,
        fire.orchName,
        fire.initialInput ?? null,
        fire.ownerId,
        Date.now(),
        fire.resolvedInputs ? JSON.stringify(fire.resolvedInputs) : null,
      );
  }

  async dequeueNextPendingFire(group: string): Promise<PendingFire | null> {
    // FIFO: oldest row by the AUTOINCREMENT id. DELETE+return atomically in a
    // transaction so two concurrent drains can't claim the same parked fire.
    const tx = this.db.transaction((): PendingFire | null => {
      const row = this.db
        .prepare<[string]>(
          `SELECT id, orch_name, initial_input, owner_id, resolved_inputs FROM pending_fires
            WHERE group_key = ?
            ORDER BY id ASC LIMIT 1`,
        )
        .get(group) as
        | {
            id: number;
            orch_name: string;
            initial_input: string | null;
            owner_id: string;
            resolved_inputs: string | null;
          }
        | undefined;
      if (!row) return null;
      this.db.prepare(`DELETE FROM pending_fires WHERE id = ?`).run(row.id);
      return {
        orchName: row.orch_name,
        initialInput: row.initial_input ?? null,
        ownerId: row.owner_id,
        ...(row.resolved_inputs
          ? { resolvedInputs: JSON.parse(row.resolved_inputs) as Record<string, string> }
          : {}),
      };
    });
    return tx();
  }

  async countPendingFires(group: string): Promise<number> {
    const row = this.db
      .prepare<[string]>(
        `SELECT COUNT(*) AS n FROM pending_fires WHERE group_key = ?`,
      )
      .get(group) as { n: number };
    return row.n;
  }

  async listPendingFires(group?: string): Promise<PendingFireRecord[]> {
    // Oldest-first by the AUTOINCREMENT id — the exact order
    // dequeueNextPendingFire drains in, so the visibility endpoint shows the
    // true FIFO. Read-only: never touches the rows.
    const rows = (
      group
        ? this.db
            .prepare<[string]>(
              `SELECT id, group_key, orch_name, initial_input, owner_id, ts
                 FROM pending_fires WHERE group_key = ? ORDER BY id ASC`,
            )
            .all(group)
        : this.db
            .prepare(
              `SELECT id, group_key, orch_name, initial_input, owner_id, ts
                 FROM pending_fires ORDER BY id ASC`,
            )
            .all()
    ) as Array<{
      id: number;
      group_key: string;
      orch_name: string;
      initial_input: string | null;
      owner_id: string;
      ts: number;
    }>;
    return rows.map(r => ({
      id: Number(r.id),
      group: r.group_key,
      orchName: r.orch_name,
      initialInput: r.initial_input ?? null,
      ownerId: r.owner_id,
      queuedAt: Number(r.ts),
    }));
  }

  async withdrawPendingFire(
    id: number,
    group?: string,
  ): Promise<PendingFireRecord | null> {
    // Remove ONE parked fire by its FIFO id WITHOUT starting it — the
    // operator's "don't run this queued work" verb (a drain is the only other
    // way a fire leaves the queue, and a drain HATCHES it). Group-conditional
    // in the same statement so an id/group mismatch can't delete across
    // groups. Transactional select-then-delete like dequeueNextPendingFire:
    // if a concurrent drain claimed the row first, the SELECT misses and we
    // return null — the fire either started or was withdrawn, never both.
    const tx = this.db.transaction((): PendingFireRecord | null => {
      const row = (
        group !== undefined
          ? this.db
              .prepare<[number, string]>(
                `SELECT id, group_key, orch_name, initial_input, owner_id, ts
                   FROM pending_fires WHERE id = ? AND group_key = ?`,
              )
              .get(id, group)
          : this.db
              .prepare<[number]>(
                `SELECT id, group_key, orch_name, initial_input, owner_id, ts
                   FROM pending_fires WHERE id = ?`,
              )
              .get(id)
      ) as
        | {
            id: number;
            group_key: string;
            orch_name: string;
            initial_input: string | null;
            owner_id: string;
            ts: number;
          }
        | undefined;
      if (!row) return null;
      this.db.prepare(`DELETE FROM pending_fires WHERE id = ?`).run(row.id);
      return {
        id: Number(row.id),
        group: row.group_key,
        orchName: row.orch_name,
        initialInput: row.initial_input ?? null,
        ownerId: row.owner_id,
        queuedAt: Number(row.ts),
      };
    });
    return tx();
  }

  async pruneTerminalDeliveries(
    olderThanMs: number,
    now: number,
  ): Promise<{ count: number }> {
    const cutoff = now - olderThanMs;
    // Terminal statuses only — `pending` / `claimed` are live work.
    const res = this.db
      .prepare<[number]>(
        `DELETE FROM trigger_deliveries
          WHERE status IN ('fired','rejected','deferred','duplicate','failed','accepted')
            AND received_at < ?`,
      )
      .run(cutoff);
    return { count: res.changes };
  }

  async pruneTerminalRuns(
    olderThanMs: number,
    now: number,
  ): Promise<{ count: number; reclaimedBytes: number | null }> {
    const cutoff = now - olderThanMs;
    // Age = COALESCE(ended_at, updated_at): a terminal row normally stamps
    // ended_at; a legacy/imported one that didn't still ages out via its last
    // write. Status filter is the safety property — 'paused' / 'interrupted' /
    // 'running' rows are resumable (or alive) and NEVER match, however old.
    const where = `status IN ('done', 'error', 'cancelled')
             AND COALESCE(ended_at, updated_at) < ?`;

    // ── BATCHED, because better-sqlite3 is SYNCHRONOUS ────────────────────
    //
    // This was one unbatched `DELETE … WHERE run_id IN (SELECT …)` with no
    // LIMIT, inside one transaction, plus a synchronous VACUUM. Every one of
    // those blocks the whole Node event loop — HTTP, SSE, cron, the delivery
    // worker, and critically the 40s LEASE RENEWAL. Measured at 21.5s + 3.3s
    // on a 1.5 GB store, which is small; past DEFAULT_LEASE_TTL_MS (120s) a
    // peer reclaims this process's live runs and RE-EXECUTES them with their
    // real side effects. The retention sweep could cause precisely the
    // split-brain the lease exists to prevent.
    //
    // Batching bounds each stall to one batch and yields the loop between
    // them, so heartbeats keep flowing through a long prune.
    const batch = envPositiveInt('SAMMY_RETENTION_BATCH', 500);
    const selectBatch = this.db.prepare<[number, number]>(
      `SELECT id FROM runs WHERE ${where} LIMIT ?`,
    );
    const delEvents = this.db.prepare<[string]>(
      `DELETE FROM events WHERE run_id = ?`,
    );
    // The status predicate is REPEATED on the delete, not trusted from the
    // select: a resume's CAS can flip a selected `error` row to `running`
    // between the two statements, and an unconditional delete-by-id would
    // then erase a live run and its events. Zero rows changed means the row
    // moved on — skip its events too.
    const delRun = this.db.prepare<[string]>(
      `DELETE FROM runs WHERE id = ? AND status IN ('done', 'error', 'cancelled')`,
    );
    const deleteOneBatch = this.db.transaction((ids: string[]): number => {
      let deleted = 0;
      for (const id of ids) {
        if (delRun.run(id).changes === 0) continue;
        delEvents.run(id);
        deleted += 1;
      }
      return deleted;
    });

    const sizeBefore = this.fileSizeBytes();
    let count = 0;
    for (;;) {
      const ids = (selectBatch.all(cutoff, batch) as Array<{ id: string }>).map(
        r => r.id,
      );
      if (ids.length === 0) break;
      count += deleteOneBatch.immediate(ids);
      // A short batch means that was the last one — stop BEFORE yielding, so a
      // prune that fits in one batch (the common case, and every unit test)
      // never defers to a macrotask. That also keeps this callable under fake
      // timers, where a `setImmediate` would never fire.
      if (ids.length < batch) break;
      // Hand the loop back between batches so lease renewals, SSE writes and
      // cron ticks are not starved by a long prune.
      await new Promise<void>(resolve => setImmediate(resolve));
    }

    let reclaimedBytes: number | null = null;
    // VACUUM rewrites the ENTIRE file and cannot be batched or interrupted —
    // on a multi-GB store that is a multi-second synchronous freeze with the
    // same lease-expiry consequence as above. Deleted pages are reused by
    // future writes either way, so reclaiming the bytes is a disk-space
    // optimisation, not a correctness one: opt in with
    // SAMMY_RETENTION_VACUUM=1 when a maintenance window makes it safe.
    if (count > 0 && process.env.SAMMY_RETENTION_VACUUM === '1') {
      try {
        this.db.exec('VACUUM');
        const sizeAfter = this.fileSizeBytes();
        if (sizeBefore !== null && sizeAfter !== null) {
          reclaimedBytes = Math.max(0, sizeBefore - sizeAfter);
        }
      } catch {
        /* best-effort compaction */
      }
    }
    return { count, reclaimedBytes };
  }

  /** Size of the main db file, or null when unreadable. WAL side files are
   *  excluded deliberately — the banner/retention lines describe runs.db. */
  private fileSizeBytes(): number | null {
    try {
      return statSync(this.file).size;
    } catch {
      return null;
    }
  }

  async costSummary(ownerId?: string): Promise<{ todayUsd: number; monthUsd: number }> {
    const now = new Date();
    const startOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const startOfMonth = new Date(
      now.getFullYear(),
      now.getMonth(),
      1,
    ).getTime();
    // BOUND THE SUBQUERY, not just the outer join.
    //
    // The `started_at` filter used to sit only on the outer `runs` join while
    // the `GROUP BY run_id` subquery had no WHERE at all — so this scanned and
    // JSON-parsed the ENTIRE events table, then threw almost all of it away.
    // It runs on every run start (13 call sites) plus `GET /api/budget/status`,
    // which the Pipelines landing page calls, so the spend cap became the
    // throughput ceiling and then a timeout source: measured at 8.6s on a
    // 1.5 GB store, minutes at 100k runs.
    //
    // Restricting the inner aggregate to the same month-to-date window makes
    // it an index-ranged scan of the rows that can possibly contribute.
    //
    // PHASE-END + PHASE-ERROR ONLY. The executor also emits `{type:'cost',
    // costUsd}` after every agent phase, and that figure is the run's
    // CUMULATIVE total, not the phase's own. Summing `costUsd` over every
    // event type therefore counted a 3-phase, $3 run as $9 (1 + 1+2 + 1+2+3)
    // — over-counting 3–11× against the cap on a real orchestration. Every
    // other consumer (sumCostUsd, the controller's mid-run gate) already
    // filters to phase-end; this one did not, and the fixtures only ever held
    // phase-ends, so it was invisible. A leaf's phase-error carries what its
    // FAILED attempt spent (no phase-end follows a failure, and `retry` pays
    // again) — the same per-attempt delta, so it sums without double-counting.
    const row = this.db
      .prepare<unknown[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN r.started_at >= ? THEN c.cost ELSE 0 END), 0) AS today,
           COALESCE(SUM(c.cost), 0) AS month
         FROM runs r
         JOIN (
           SELECT e.run_id,
                  SUM(COALESCE(json_extract(e.event_json, '$.costUsd'), 0)) AS cost
           FROM events e
           WHERE e.run_id IN (SELECT id FROM runs WHERE started_at >= ?)
             AND json_extract(e.event_json, '$.type') IN ('phase-end', 'phase-error')
           GROUP BY e.run_id
         ) c ON c.run_id = r.id
         WHERE r.started_at >= ?${ownerId !== undefined ? ' AND r.owner_id = ?' : ''}`,
      )
      .get(
        ...(ownerId !== undefined
          ? [startOfDay, startOfMonth, startOfMonth, ownerId]
          : [startOfDay, startOfMonth, startOfMonth]),
      ) as {
        today: number;
        month: number;
      };
    return { todayUsd: row.today ?? 0, monthUsd: row.month ?? 0 };
  }

  async orchestrationUsage(
    orchestrationName: string,
    window: { dayStart: number; monthStart: number },
  ): Promise<{ runsToday: number; todayUsd: number; monthUsd: number }> {
    const from = Math.min(window.dayStart, window.monthStart);
    const runs = this.db
      .prepare<unknown[]>(
        `SELECT COUNT(*) AS n FROM runs
          WHERE orchestration_name = ? AND started_at >= ?`,
      )
      .get(orchestrationName, window.dayStart) as { n: number };
    const cost = this.db
      .prepare<unknown[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN r.started_at >= ? THEN c.cost ELSE 0 END), 0) AS today,
           COALESCE(SUM(CASE WHEN r.started_at >= ? THEN c.cost ELSE 0 END), 0) AS month
         FROM runs r
         JOIN (
           SELECT e.run_id,
                  SUM(COALESCE(json_extract(e.event_json, '$.costUsd'), 0)) AS cost
           FROM events e
           WHERE e.run_id IN (
                   SELECT id FROM runs
                    WHERE orchestration_name = ? AND started_at >= ?)
             AND json_extract(e.event_json, '$.type') IN ('phase-end', 'phase-error')
           GROUP BY e.run_id
         ) c ON c.run_id = r.id
         WHERE r.orchestration_name = ? AND r.started_at >= ?`,
      )
      .get(
        window.dayStart,
        window.monthStart,
        orchestrationName,
        from,
        orchestrationName,
        from,
      ) as { today: number; month: number };
    return {
      runsToday: runs.n ?? 0,
      todayUsd: cost.today ?? 0,
      monthUsd: cost.month ?? 0,
    };
  }

  async close(): Promise<void> {
    this.db?.close();
  }
}
